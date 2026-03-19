"""
D365 Deploy Service — Compile C# plugins and deploy to Dynamics 365 / Dataverse.

Pipeline per component type:
  apex_class / apex_trigger  → compile .cs → register assembly → register step → publish
  lwc / aura                 → deploy as HTML web resource → publish
  flow                       → not automatable; return manual instructions

Folder layout (per org connection):
  backend/data/orgs/{connection_id}/
    keys/PluginKey.snk          (signing key — generated once per org)
    compiled/{name}_{ts}/       (per-build temp dir)
      Plugin.cs
      Plugin.csproj
      bin/Release/net462/*.dll
    logs/deploy_{name}_{ts}.log (full log file for download)
"""

import base64
import json
import os
import re
import subprocess
import tempfile
import textwrap
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


# ── Folder helpers ────────────────────────────────────────────────────────────

def _org_dir(connection_id: int) -> Path:
    base = Path(__file__).resolve().parent.parent.parent / "data" / "orgs" / str(connection_id)
    base.mkdir(parents=True, exist_ok=True)
    return base


def _keys_dir(connection_id: int) -> Path:
    d = _org_dir(connection_id) / "keys"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _logs_dir(connection_id: int) -> Path:
    d = _org_dir(connection_id) / "logs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _compiled_dir(connection_id: int, name: str) -> Path:
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe = re.sub(r"[^\w\-]", "_", name)
    d = _org_dir(connection_id) / "compiled" / f"{safe}_{ts}"
    d.mkdir(parents=True, exist_ok=True)
    return d


# ── Logger helper ─────────────────────────────────────────────────────────────

class _StepLogger:
    """Accumulates deployment steps, writes to file, returns log text."""

    def __init__(self, log_path: Path):
        self._path = log_path
        self._lines: list[str] = []
        self._start = time.time()
        self._write(f"=== Deployment log started at {datetime.now(timezone.utc).isoformat()} ===\n")

    def _write(self, text: str):
        self._lines.append(text)
        with open(self._path, "a", encoding="utf-8") as f:
            f.write(text + "\n")

    def step(self, msg: str):
        ts = f"[{time.time() - self._start:6.1f}s]"
        self._write(f"{ts} ► {msg}")

    def ok(self, msg: str):
        ts = f"[{time.time() - self._start:6.1f}s]"
        self._write(f"{ts} ✓ {msg}")

    def err(self, msg: str):
        ts = f"[{time.time() - self._start:6.1f}s]"
        self._write(f"{ts} ✗ {msg}")

    def info(self, msg: str):
        ts = f"[{time.time() - self._start:6.1f}s]"
        self._write(f"{ts}   {msg}")

    def finish(self, success: bool):
        self._write(f"\n=== {'SUCCESS' if success else 'FAILED'} — {time.time() - self._start:.1f}s elapsed ===")

    @property
    def text(self) -> str:
        return "\n".join(self._lines)

    @property
    def text_truncated(self) -> str:
        """DB-safe version capped at 50k chars."""
        t = self.text
        return t[-50000:] if len(t) > 50000 else t


# ── dotnet check ──────────────────────────────────────────────────────────────

def check_dotnet() -> tuple[bool, str]:
    """Returns (available, version_string)."""
    try:
        r = subprocess.run(["dotnet", "--version"], capture_output=True, text=True, timeout=10)
        if r.returncode == 0:
            return True, r.stdout.strip()
        return False, "dotnet returned non-zero"
    except FileNotFoundError:
        return False, "dotnet not found in PATH"
    except Exception as exc:
        return False, str(exc)


# ── SNK key generation ────────────────────────────────────────────────────────

# Bundled 1024-bit RSA key pair in PRIVATEKEYBLOB format (development use only).
# Generate your own with: dotnet sn -k YourKey.snk
_SHARED_DEV_SNK_B64 = (
    "BwIAAACkAABSU0EyAAQAAAEAAQCvb5Qi1fIb2X5F6mVu6CKWFvYvB5T7mB9YOJm1iqRm"
    "0e5nEQpQ7v8SB+mfXrWeSp8C9o6Bx+Pmo/E2AHpOeGi2RfHcDd1kUkYFJiHbSRVRlJD"
    "c7iFVqVT9raTMELjPbRTRkRuFZ3dHJxNkBiLFPaJMOHpyRRuJnXpJ1U/vdw/E0MaJ3RI"
    "bZqDCt2BYVLSdL2HMKSjZgRxIKtfFTnpxFOBOsKSNfbDhJD9hMDLZJEPjy3V0FXHJ+f"
    "JCl8HuQ1dxKJZ8TP7VrOSYB2dFm5OXFQ6FS4jMiJKhKRLjLBrJNiHCpw6gFQ7QLCF2P"
    "pNWjuKU7n8GH2YN2qJ3YXd5M6JmwFOZ8c/kIPvXBBjlyLhcHaqmg5qQ0P6Uw1QX4ZRQR"
    "q+JkMwnCFSvxpT2n1kbGRh/OmB5LTSJ8Q8Q8JKs3YMEo2F+D7B8QPf5Fp0MCXFnBjqUC"
    "CXA/6SqEF+k5gNPJPiSjRWj3hPBK4bXq0eTRV5G2u6WRZ8rQ2BKb7F0sATBPnBQZsRHO"
    "k0/HJGwVoRkh0YXpDPz3b5lHvOV+8w7PQWQ/PYR2qFrb0EfwDr+QJr7w4KFJh3Kw1IA"
    "SUHQ2UB1mO1OxCN8GZ5KQzKJ8hP5V6jFJr3zG8D7Kp0M9o5n7f4L3Q2dFqPWQ0RV6K8"
    "kVZhFIvlXJbGYqpLMBz9F8OmHXrS6fgA1Kk8zt1dPCmqLV1jBNLSH5nfM1A3WfO5n7D"
    "Mm0KcD7Rp4Q6JB8k0V5KFXN3QKlZ8mHb5pVJR2YxP7Q8m4N9ZFrTMBqD6kzGCHY0V9N"
    "TJKLmS3N4QpZB2fKHJV5LR8nMX7D0GqWFP1Ct6RdY5V8I3nZ2KQmbO4X8Y9DP0N3wFHe"
    "EF1GJ3KL5R2A7N9YD8Pm4VQ0TBJzK7XL6W2H3N1F9R4Y8D0M5V2K7J6P3X8Q1W0N4T5"
    "HJnPQ7KL5Y2N3R1F9X4D8M0V2W7J6P3K8Q1T0N4H5Y2R3N1L9F4D8M0V2K7J6P3X8Q1"
)


def _ensure_snk(connection_id: int, log: _StepLogger) -> Path:
    snk_path = _keys_dir(connection_id) / "PluginKey.snk"
    if snk_path.exists():
        log.ok(f"Using existing signing key: {snk_path}")
        return snk_path

    # Try generating with dotnet sn tool
    ok, ver = check_dotnet()
    if ok:
        try:
            r = subprocess.run(
                ["dotnet", "sn", "-k", str(snk_path)],
                capture_output=True, text=True, timeout=30,
            )
            if r.returncode == 0 and snk_path.exists():
                log.ok(f"Generated new signing key via dotnet sn: {snk_path}")
                return snk_path
        except Exception:
            pass

    # Fall back: generate RSA-1024 SNK using Python cryptography library
    try:
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.hazmat.backends import default_backend
        import struct as _struct

        key = rsa.generate_private_key(public_exponent=65537, key_size=1024, backend=default_backend())
        nums = key.private_numbers()
        pub_nums = nums.public_numbers

        # Build Microsoft PRIVATEKEYBLOB (SNK format)
        blob  = bytes([0x07, 0x02, 0x00, 0x00])          # BLOBHEADER
        blob += _struct.pack('<I', 0x0000A400)             # aiKeyAlg = CALG_RSA_SIGN
        blob += b'RSA2'                                    # magic
        blob += _struct.pack('<I', 1024)                   # bitlen
        blob += _struct.pack('<I', pub_nums.e)             # pubexp
        blob += pub_nums.n.to_bytes(128, 'little')         # modulus
        blob += nums.p.to_bytes(64, 'little')              # prime1
        blob += nums.q.to_bytes(64, 'little')              # prime2
        blob += nums.dmp1.to_bytes(64, 'little')           # exponent1
        blob += nums.dmq1.to_bytes(64, 'little')           # exponent2
        blob += nums.iqmp.to_bytes(64, 'little')           # coefficient
        blob += nums.d.to_bytes(128, 'little')             # privateExponent

        snk_path.parent.mkdir(parents=True, exist_ok=True)
        snk_path.write_bytes(blob)
        log.ok(f"Generated signing key ({len(blob)} bytes) → {snk_path}")
        return snk_path
    except Exception as exc:
        log.err(f"Could not generate signing key: {exc}")
        return snk_path


# ── C# compilation ────────────────────────────────────────────────────────────

_CSPROJ_TEMPLATE = textwrap.dedent("""\
    <Project Sdk="Microsoft.NET.Sdk">
      <PropertyGroup>
        <TargetFramework>net462</TargetFramework>
        <AssemblyName>{assembly_name}</AssemblyName>
        <RootNamespace>{assembly_name}</RootNamespace>
        <Optimize>true</Optimize>
        <SignAssembly>true</SignAssembly>
        <AssemblyOriginatorKeyFile>{key_file}</AssemblyOriginatorKeyFile>
      </PropertyGroup>
      <ItemGroup>
        <PackageReference Include="Microsoft.CrmSdk.CoreAssemblies" Version="9.0.2.56" />
      </ItemGroup>
    </Project>
""")


def compile_csharp(
    csharp_code: str,
    assembly_name: str,
    connection_id: int,
    log: _StepLogger,
) -> tuple[bool, bytes, str]:
    """
    Compile C# code to a DLL.
    Returns (success, dll_bytes, error_message).
    """
    ok, ver = check_dotnet()
    if not ok:
        msg = (
            f"dotnet CLI not found ({ver}). "
            "Install .NET SDK 6+ from https://dotnet.microsoft.com/download to enable C# compilation."
        )
        log.err(msg)
        return False, b"", msg

    log.step(f"Compiling C# → {assembly_name}.dll  (dotnet {ver})")
    build_dir = _compiled_dir(connection_id, assembly_name)
    snk_path = _ensure_snk(connection_id, log)

    # Strip markdown code fences if LLM wrapped the output (```csharp ... ```)
    clean_code = csharp_code.strip()
    if clean_code.startswith("```"):
        lines = clean_code.splitlines()
        # drop first line (```csharp or ```) and last line (```)
        end = len(lines) - 1
        while end > 0 and lines[end].strip() == "":
            end -= 1
        if lines[end].strip() == "```":
            lines = lines[1:end]
        else:
            lines = lines[1:]
        clean_code = "\n".join(lines)

    # Write source files
    cs_path = build_dir / "Plugin.cs"
    csproj_path = build_dir / f"{assembly_name}.csproj"

    cs_path.write_text(clean_code, encoding="utf-8")
    csproj_path.write_text(
        _CSPROJ_TEMPLATE.format(
            assembly_name=assembly_name,
            key_file=str(snk_path),
        ),
        encoding="utf-8",
    )

    log.info(f"Build dir: {build_dir}")
    log.info(f"Source:    Plugin.cs ({len(clean_code)} chars)")

    try:
        r = subprocess.run(
            ["dotnet", "build", str(csproj_path), "-c", "Release", "--nologo", "-v", "minimal"],
            capture_output=True, text=True, timeout=120, cwd=str(build_dir),
        )
    except subprocess.TimeoutExpired:
        log.err("dotnet build timed out (120s)")
        return False, b"", "dotnet build timed out"
    except Exception as exc:
        log.err(f"dotnet build failed: {exc}")
        return False, b"", str(exc)

    if r.stdout:
        for line in r.stdout.splitlines():
            log.info(f"  {line}")
    if r.stderr:
        for line in r.stderr.splitlines():
            log.info(f"  STDERR: {line}")

    if r.returncode != 0:
        err = f"Compilation failed (exit {r.returncode})"
        log.err(err)
        return False, b"", err

    # Find DLL
    dll_candidates = list(build_dir.glob(f"bin/Release/**/{assembly_name}.dll"))
    if not dll_candidates:
        dll_candidates = list(build_dir.glob("bin/**/*.dll"))

    if not dll_candidates:
        log.err("DLL not found after build")
        return False, b"", "DLL not found after build"

    dll_path = dll_candidates[0]
    dll_bytes = dll_path.read_bytes()
    log.ok(f"Compiled → {dll_path.name} ({len(dll_bytes):,} bytes)")
    return True, dll_bytes, ""


# ── D365 API helpers ──────────────────────────────────────────────────────────

def _d365_headers(access_token: str) -> dict:
    return {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
        "Accept": "application/json",
    }


def _d365_get_token(d365_cfg: dict) -> str:
    """Get Azure AD access token for D365 Dataverse."""
    import requests as _req
    tenant_id  = d365_cfg.get("d365_tenant_id", "")
    client_id  = d365_cfg.get("d365_client_id", "")
    client_sec = d365_cfg.get("d365_client_secret", "")
    env_url    = d365_cfg.get("d365_environment_url", "").rstrip("/")

    if not all([tenant_id, client_id, client_sec, env_url]):
        raise ValueError("Missing D365 credentials (tenant_id, client_id, client_secret, environment_url)")

    token_url = f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"
    resp = _req.post(
        token_url,
        data={
            "grant_type":    "client_credentials",
            "client_id":     client_id,
            "client_secret": client_sec,
            "scope":         f"{env_url}/.default",
        },
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


def _d365_api(method: str, endpoint: str, env_url: str, token: str, body: dict = None) -> dict:
    """Make a D365 Web API call."""
    import requests as _req
    url = f"{env_url.rstrip('/')}/api/data/v9.2/{endpoint.lstrip('/')}"
    headers = _d365_headers(token)
    # PublishAllXml is slow — allow up to 120s; everything else 30s
    _timeout = 120 if "PublishAllXml" in endpoint else 30
    if method.upper() in ("POST", "PUT", "PATCH"):
        resp = _req.request(method, url, headers=headers, json=body or {}, timeout=_timeout)
    else:
        resp = _req.request(method, url, headers=headers, timeout=_timeout)

    if not resp.ok:
        try:
            err_body = resp.json()
            err_msg = err_body.get("error", {}).get("message", resp.text)
        except Exception:
            err_msg = resp.text
        raise RuntimeError(f"D365 API {method} {endpoint} → {resp.status_code}: {err_msg}")

    if resp.status_code == 204 or not resp.content:
        # Extract ID from OData-EntityId header if present
        entity_id_header = resp.headers.get("OData-EntityId", "")
        if entity_id_header:
            # Extract GUID from: https://.../{entity}({guid})
            m = re.search(r"\(([0-9a-f\-]{36})\)", entity_id_header)
            if m:
                return {"id": m.group(1)}
        return {}

    return resp.json()


# ── Plugin (Apex → IPlugin) deployment ────────────────────────────────────────

def _infer_entity_name(component_name: str, source_code: str = "") -> str:
    """
    Try to infer the D365 entity logical name from the code or component name.
    Falls back to 'account' as a safe default.
    """
    # Try regex patterns in source code
    patterns = [
        r'ctx\.PrimaryEntityName\s*!=\s*"([^"]+)"',
        r'PrimaryEntityName\s*==\s*"([^"]+)"',
        r'entity\s*=\s*"([^"]+)"',
    ]
    for p in patterns:
        m = re.search(p, source_code or "")
        if m:
            return m.group(1).lower()

    # Derive from component name: AccountTrigger → account
    name_lower = component_name.lower()
    for candidate in ["account", "contact", "opportunity", "lead", "case", "order", "quote"]:
        if candidate in name_lower:
            return candidate

    return "account"


def _infer_messages(component_type: str, source_code: str = "") -> list[str]:
    """Infer which D365 messages (Create/Update/Delete) to register for."""
    code = source_code or ""
    messages = []
    if "Create" in code or "insert" in code.lower() or "create" in code.lower():
        messages.append("Create")
    if "Update" in code or "update" in code.lower():
        messages.append("Update")
    if "Delete" in code or "delete" in code.lower():
        messages.append("Delete")

    if not messages:
        # Default for triggers is Create + Update; for classes it's Create
        messages = ["Create", "Update"] if component_type == "apex_trigger" else ["Create"]

    return messages


def _infer_stage(component_type: str, source_code: str = "") -> int:
    """Infer plugin stage: 20=PreOperation, 40=PostOperation."""
    code = source_code or ""
    # PostOperation patterns
    if "Stage=40" in code or "stage=40" in code or "PostOperation" in code or "after" in code.lower():
        return 40
    # PreOperation patterns or default for triggers
    if "Stage=20" in code or "PreOperation" in code or "before" in code.lower():
        return 20
    # Default: triggers go PreOperation, classes go PostOperation
    return 20 if component_type == "apex_trigger" else 40


def _infer_mode(source_code: str = "") -> int:
    """Infer execution mode: 0=Synchronous, 1=Asynchronous."""
    code = source_code or ""
    if "@future" in code or "Asynchronous" in code or "mode=1" in code.lower():
        return 1
    return 0


def _extract_plugin_classname(csharp_code: str, fallback: str) -> str:
    """
    Extract the fully-qualified IPlugin / CodeActivity class name from C# source.
    D365 typename MUST be 'Namespace.ClassName' — a bare class name causes
    '412: A record with matching key values already exists' on retry or
    '400: PluginType [Foo] not found in PluginAssembly' when namespace differs.
    """
    # Extract namespace declaration
    ns_match = re.search(r'namespace\s+([\w\.]+)', csharp_code)
    namespace = ns_match.group(1) if ns_match else ""

    # IPlugin: "public class Foo : IPlugin" or "public class Foo : SomeBase, IPlugin"
    m = re.search(r'public\s+class\s+(\w+)\s*[:<][^{]*IPlugin', csharp_code)
    if m:
        classname = m.group(1)
        return f"{namespace}.{classname}" if namespace else classname
    # CodeActivity
    m = re.search(r'public\s+class\s+(\w+)\s*[:<][^{]*CodeActivity', csharp_code)
    if m:
        classname = m.group(1)
        return f"{namespace}.{classname}" if namespace else classname
    # Any public class as last resort
    m = re.search(r'public\s+class\s+(\w+)', csharp_code)
    if m:
        classname = m.group(1)
        return f"{namespace}.{classname}" if namespace else classname
    return f"{namespace}.{fallback}" if namespace else fallback


def deploy_plugin(
    csharp_code: str,
    assembly_name: str,
    component_type: str,
    component_name: str,
    connection_id: int,
    d365_cfg: dict,
    source_code: str = "",
    log: _StepLogger = None,
) -> dict:
    """
    Full pipeline: compile C# → register assembly → register steps → publish.
    Returns result dict with assembly_id, step_ids, errors.
    """
    result = {"assembly_id": None, "step_ids": [], "errors": []}

    # Extract the actual class name from source — D365 typename must match DLL class name
    plugin_classname = _extract_plugin_classname(csharp_code, assembly_name)
    if plugin_classname != assembly_name:
        log.info(f"Detected plugin class name: {plugin_classname} (assembly: {assembly_name})")

    # 1. Compile
    ok, dll_bytes, compile_err = compile_csharp(csharp_code, assembly_name, connection_id, log)
    if not ok:
        result["errors"].append(f"Compilation failed: {compile_err}")
        return result

    env_url = d365_cfg.get("d365_environment_url", "").rstrip("/")

    # 2. Auth
    log.step("Authenticating with Dynamics 365...")
    try:
        token = _d365_get_token(d365_cfg)
        log.ok("D365 token acquired")
    except Exception as exc:
        err = f"D365 auth failed: {exc}"
        log.err(err)
        result["errors"].append(err)
        return result

    # 3. Register or update assembly (upsert by name)
    log.step(f"Registering plugin assembly: {assembly_name}")
    dll_b64 = base64.b64encode(dll_bytes).decode("utf-8")
    assembly_id = None
    try:
        # Check if assembly already exists
        existing = _d365_api(
            "GET",
            f"pluginassemblies?$filter=name eq '{assembly_name}'&$select=pluginassemblyid,name",
            env_url, token,
        )
        existing_list = existing.get("value", [])
        if existing_list:
            # Try to PATCH the first matching assembly
            assembly_id = existing_list[0]["pluginassemblyid"]
            log.info(f"Found {len(existing_list)} existing assembly(ies), updating DLL...")
            try:
                _d365_api("PATCH", f"pluginassemblies({assembly_id})", env_url, token, {
                    "content": dll_b64,
                    "version": "1.0.0.0",
                })
                result["assembly_id"] = assembly_id
                log.ok(f"Assembly updated: {assembly_id}")
            except Exception as patch_exc:
                # PublicKeyToken changed — delete ALL matching assemblies then re-register
                log.info(f"PATCH failed ({patch_exc}), clearing all old assemblies...")
                for asm in existing_list:
                    try:
                        aid = asm["pluginassemblyid"]
                        # Must delete: sdkmessageprocessingsteps → plugintypes → pluginassembly
                        # Skipping steps causes "referenced by N other components" on assembly DELETE
                        ptypes = _d365_api("GET", f"plugintypes?$filter=_pluginassemblyid_value eq '{aid}'&$select=plugintypeid,typename", env_url, token)
                        for pt in ptypes.get("value", []):
                            ptid = pt["plugintypeid"]
                            # Delete all steps referencing this plugin type first
                            steps = _d365_api("GET", f"sdkmessageprocessingsteps?$filter=_plugintypeid_value eq '{ptid}'&$select=sdkmessageprocessingstepid", env_url, token)
                            for step in steps.get("value", []):
                                try:
                                    _d365_api("DELETE", f"sdkmessageprocessingsteps({step['sdkmessageprocessingstepid']})", env_url, token)
                                    log.info(f"    Removed step: {step['sdkmessageprocessingstepid']}")
                                except Exception:
                                    pass
                            try:
                                _d365_api("DELETE", f"plugintypes({ptid})", env_url, token)
                                log.info(f"    Removed plugin type: {pt.get('typename', ptid)}")
                            except Exception:
                                pass
                        _d365_api("DELETE", f"pluginassemblies({aid})", env_url, token)
                        log.info(f"  Removed assembly: {aid}")
                    except Exception as del_exc:
                        log.info(f"  Could not remove {asm['pluginassemblyid']}: {del_exc}")
                import time as _time; _time.sleep(2)   # brief delay for D365 consistency
                asm_resp = _d365_api("POST", "pluginassemblies", env_url, token, {
                    "name":         assembly_name,
                    "content":      dll_b64,
                    "culture":      "neutral",
                    "version":      "1.0.0.0",
                    "sourcetype":   0,
                    "isolationmode": 2,
                })
                assembly_id = asm_resp.get("id") or asm_resp.get("pluginassemblyid", "")
                if not assembly_id:
                    raise RuntimeError(f"Re-registration failed: {asm_resp}")
                result["assembly_id"] = assembly_id
                log.ok(f"Assembly re-registered: {assembly_id}")
        else:
            asm_resp = _d365_api("POST", "pluginassemblies", env_url, token, {
                "name":         assembly_name,
                "content":      dll_b64,
                "culture":      "neutral",
                "version":      "1.0.0.0",
                "sourcetype":   0,   # 0 = store in database
                "isolationmode": 2,  # 2 = sandbox
            })
            assembly_id = asm_resp.get("id") or asm_resp.get("pluginassemblyid", "")
            if not assembly_id:
                raise RuntimeError(f"No assembly ID in response: {asm_resp}")
            result["assembly_id"] = assembly_id
            log.ok(f"Assembly registered: {assembly_id}")
    except Exception as exc:
        err = f"Assembly registration failed: {exc}"
        log.err(err)
        result["errors"].append(err)
        return result

    # 4. Register plugin type (POST, not GET — D365 does not auto-create types)
    log.step("Registering plugin type...")
    type_id = None
    try:
        # Check for existing plugin types on this assembly
        types_resp = _d365_api(
            "GET",
            f"plugintypes?$filter=_pluginassemblyid_value eq '{assembly_id}'&$select=plugintypeid,typename",
            env_url, token,
        )
        types = types_resp.get("value", [])

        # Validate typename matches the fully-qualified class name we extracted.
        # If an old type exists with a wrong name (e.g. bare class name from a previous run),
        # delete it so we can register the correct one — otherwise D365 returns 412 on retry.
        matched_type = next((t for t in types if t.get("typename") == plugin_classname), None)
        stale_types  = [t for t in types if t.get("typename") != plugin_classname]

        for stale in stale_types:
            stale_id = stale["plugintypeid"]
            log.info(f"  Removing stale plugin type '{stale.get('typename', stale_id)}' (typename mismatch)…")
            # Delete steps referencing stale type first
            stale_steps = _d365_api("GET", f"sdkmessageprocessingsteps?$filter=_plugintypeid_value eq '{stale_id}'&$select=sdkmessageprocessingstepid", env_url, token)
            for s in stale_steps.get("value", []):
                try: _d365_api("DELETE", f"sdkmessageprocessingsteps({s['sdkmessageprocessingstepid']})", env_url, token)
                except Exception: pass
            try: _d365_api("DELETE", f"plugintypes({stale_id})", env_url, token)
            except Exception: pass

        if matched_type:
            type_id = matched_type["plugintypeid"]
            log.ok(f"Plugin type already exists with correct typename: {plugin_classname} → {type_id}")
        else:
            # typename must exactly match the fully-qualified class name in the compiled DLL
            type_body = {
                "typename":    plugin_classname,
                "friendlyname": plugin_classname,
                "name":        plugin_classname,
                "pluginassemblyid@odata.bind": f"/pluginassemblies({assembly_id})",
            }
            type_resp = _d365_api("POST", "plugintypes", env_url, token, type_body)
            type_id = type_resp.get("plugintypeid") or type_resp.get("id")
            if not type_id:
                raise RuntimeError(f"No type ID returned: {type_resp}")
            log.ok(f"Plugin type registered: {plugin_classname} → {type_id}")
    except Exception as exc:
        err = f"Failed to register plugin type: {exc}"
        log.err(err)
        result["errors"].append(err)
        return result

    # 5. Determine entity + messages + stage + mode
    entity_name = _infer_entity_name(component_name, source_code)
    messages    = _infer_messages(component_type, source_code)
    stage       = _infer_stage(component_type, source_code)
    mode        = _infer_mode(source_code)

    log.info(f"Target entity: {entity_name}")
    log.info(f"Messages: {messages}  Stage: {'Pre(20)' if stage==20 else 'Post(40)'}  Mode: {'Sync' if mode==0 else 'Async'}")

    # 6. Register steps per message
    for message_name in messages:
        log.step(f"Registering step: {message_name} on {entity_name}...")
        try:
            # Get message ID
            msg_resp = _d365_api(
                "GET",
                f"sdkmessages?$filter=name eq '{message_name}'&$select=sdkmessageid",
                env_url, token,
            )
            msg_values = msg_resp.get("value", [])
            if not msg_values:
                log.err(f"  SDK message '{message_name}' not found — skipping")
                continue
            message_id = msg_values[0]["sdkmessageid"]

            # Get message filter ID for entity
            flt_resp = _d365_api(
                "GET",
                f"sdkmessagefilters?$filter=_sdkmessageid_value eq '{message_id}' "
                f"and primaryobjecttypecode eq '{entity_name}'&$select=sdkmessagefilterid",
                env_url, token,
            )
            flt_values = flt_resp.get("value", [])
            if not flt_values:
                log.err(f"  No filter for {message_name} on {entity_name} — registering without entity filter")
                filter_binding = {}
            else:
                filter_id = flt_values[0]["sdkmessagefilterid"]
                filter_binding = {
                    "sdkmessagefilterid@odata.bind": f"/sdkmessagefilters({filter_id})"
                }

            # Register step — idempotent: check for an existing step on this type+message first
            step_name = f"{message_name} - {plugin_classname}"
            existing_steps = _d365_api(
                "GET",
                f"sdkmessageprocessingsteps?$filter=_plugintypeid_value eq '{type_id}'"
                f" and _sdkmessageid_value eq '{message_id}'&$select=sdkmessageprocessingstepid,name",
                env_url, token,
            )
            existing_step_list = existing_steps.get("value", [])
            if existing_step_list:
                step_id = existing_step_list[0]["sdkmessageprocessingstepid"]
                result["step_ids"].append(step_id)
                log.ok(f"  Step already exists: {message_name} → {step_id} (reused)")
            else:
                step_body = {
                    "name":        step_name,
                    "description": f"Migrated from Salesforce {component_type}: {component_name}",
                    "stage":       stage,
                    "mode":        mode,
                    "rank":        1,
                    "plugintypeid@odata.bind": f"/plugintypes({type_id})",
                    "sdkmessageid@odata.bind": f"/sdkmessages({message_id})",
                    **filter_binding,
                }
                step_resp = _d365_api("POST", "sdkmessageprocessingsteps", env_url, token, step_body)
                step_id = step_resp.get("id") or step_resp.get("sdkmessageprocessingstepid", "")
                if step_id:
                    result["step_ids"].append(step_id)
                    log.ok(f"  Step registered: {message_name} → {step_id}")
                else:
                    log.err(f"  No step ID returned for {message_name}")

        except Exception as exc:
            err = f"Step registration failed for {message_name}: {exc}"
            log.err(f"  {err}")
            result["errors"].append(err)

    # 7. Publish all customizations
    log.step("Publishing customizations...")
    try:
        _d365_api("POST", "PublishAllXml", env_url, token, {})
        log.ok("Customizations published")
    except Exception as exc:
        log.err(f"PublishAllXml failed (non-fatal): {exc}")
        result["errors"].append(f"Publish failed: {exc}")

    return result


# ── Web Resource (LWC/Aura → HTML) deployment ─────────────────────────────────

def deploy_web_resource(
    html_code: str,
    component_name: str,
    connection_id: int,
    d365_cfg: dict,
    log: _StepLogger,
) -> dict:
    """
    Deploy HTML web resource to D365.
    Returns result dict with web_resource_id, errors.
    """
    result = {"web_resource_id": None, "errors": []}
    env_url = d365_cfg.get("d365_environment_url", "").rstrip("/")

    log.step("Authenticating with Dynamics 365...")
    try:
        token = _d365_get_token(d365_cfg)
        log.ok("D365 token acquired")
    except Exception as exc:
        err = f"D365 auth failed: {exc}"
        log.err(err)
        result["errors"].append(err)
        return result

    # D365 web resource name: must start with publisher prefix (use "new_")
    safe_name = re.sub(r"[^\w]", "_", component_name.lower())
    wr_name   = f"new_{safe_name}"

    log.step(f"Deploying web resource: {wr_name}")

    # Extract only the HTML part if the LLM returned multiple file sections
    html_content = html_code
    if "```html" in html_code:
        m = re.search(r"```html\n(.*?)```", html_code, re.DOTALL)
        if m:
            html_content = m.group(1).strip()
    elif "<converted>" in html_code:
        m = re.search(r"<converted>(.*?)</converted>", html_code, re.DOTALL)
        if m:
            html_content = m.group(1).strip()

    html_b64 = base64.b64encode(html_content.encode("utf-8")).decode("utf-8")

    try:
        # Check if web resource already exists (upsert pattern)
        existing = _d365_api(
            "GET",
            f"webresourceset?$filter=name eq '{wr_name}'&$select=webresourceid,name",
            env_url, token,
        )
        existing_list = existing.get("value", [])

        if existing_list:
            # PATCH existing web resource
            wr_id = existing_list[0]["webresourceid"]
            log.info(f"Web resource '{wr_name}' already exists — updating content...")
            _d365_api("PATCH", f"webresourceset({wr_id})", env_url, token, {
                "content":     html_b64,
                "displayname": component_name,
                "description": f"Migrated from Salesforce LWC/Aura: {component_name}",
            })
            result["web_resource_id"] = wr_id
            log.ok(f"Web resource updated: {wr_id}")
        else:
            # POST new web resource
            wr_resp = _d365_api("POST", "webresourceset", env_url, token, {
                "name":            wr_name,
                "displayname":     component_name,
                "description":     f"Migrated from Salesforce LWC/Aura: {component_name}",
                "webresourcetype": 1,   # 1 = HTML
                "content":         html_b64,
            })
            wr_id = wr_resp.get("id") or wr_resp.get("webresourceid", "")
            if not wr_id:
                raise RuntimeError(f"No web resource ID in response: {wr_resp}")
            result["web_resource_id"] = wr_id
            log.ok(f"Web resource created: {wr_id}")
    except Exception as exc:
        err = f"Web resource creation failed: {exc}"
        log.err(err)
        result["errors"].append(err)
        return result

    # Publish
    log.step("Publishing web resource...")
    try:
        _d365_api("POST", "PublishAllXml", env_url, token, {})
        log.ok("Published")
    except Exception as exc:
        log.err(f"PublishAllXml failed (non-fatal): {exc}")
        result["errors"].append(f"Publish failed: {exc}")

    return result


# ── Main entry point ──────────────────────────────────────────────────────────

class DeployResult:
    def __init__(self):
        self.success       = False
        self.assembly_id   = None
        self.step_ids      = []
        self.web_resource_id = None
        self.errors        = []
        self.log_text      = ""
        self.log_file_path = ""
        self.is_manual     = False
        self.manual_instructions = ""


def deploy_component(
    converted_code: str,
    component_type: str,
    component_name: str,
    connection_id: int,
    d365_cfg: dict,
    source_code: str = "",
) -> DeployResult:
    """
    Main entry point. Routes to the right deployer based on component_type.
    Returns a DeployResult with all metadata.
    """
    result = DeployResult()

    # Set up log file
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe = re.sub(r"[^\w\-]", "_", component_name)
    log_path = _logs_dir(connection_id) / f"deploy_{safe}_{ts}.log"
    log = _StepLogger(log_path)
    result.log_file_path = str(log_path)

    log.step(f"Component: {component_name} ({component_type})")
    log.step(f"Target org: {d365_cfg.get('d365_environment_url', 'unknown')}")

    try:
        if component_type in ("apex_class", "apex_trigger"):
            # Clean assembly name (only alphanumeric + underscores)
            assembly_name = re.sub(r"[^\w]", "_", component_name)
            raw = deploy_plugin(
                csharp_code    = converted_code,
                assembly_name  = assembly_name,
                component_type = component_type,
                component_name = component_name,
                connection_id  = connection_id,
                d365_cfg       = d365_cfg,
                source_code    = source_code,
                log            = log,
            )
            result.assembly_id = raw.get("assembly_id")
            result.step_ids    = raw.get("step_ids", [])
            result.errors      = raw.get("errors", [])
            # Publish timeout is non-fatal — plugin steps are live even without explicit publish
            fatal_errors = [e for e in result.errors if "Publish failed" not in e]
            result.success     = result.assembly_id is not None and not fatal_errors

        elif component_type in ("lwc", "aura"):
            raw = deploy_web_resource(
                html_code      = converted_code,
                component_name = component_name,
                connection_id  = connection_id,
                d365_cfg       = d365_cfg,
                log            = log,
            )
            result.web_resource_id = raw.get("web_resource_id")
            result.errors          = raw.get("errors", [])
            result.success         = result.web_resource_id is not None and not result.errors

        elif component_type == "flow":
            result.is_manual = True
            result.success   = True   # "success" in the sense of: handled correctly
            result.manual_instructions = (
                "Salesforce Flows cannot be automatically deployed to Dynamics 365.\n"
                "The converted output is a Power Automate flow description.\n\n"
                "Manual steps:\n"
                "  1. Go to https://make.powerautomate.com\n"
                "  2. Create a new flow based on the converted description\n"
                "  3. Map field names using the field mapping from Step 4\n"
                "  4. Test and activate the flow\n\n"
                "The converted code has been saved and can be downloaded for reference."
            )
            log.info("Flow conversion: manual deployment required (Power Automate)")
            log.info(result.manual_instructions)

        else:
            err = f"Unknown component type: {component_type}"
            log.err(err)
            result.errors.append(err)

    except Exception as exc:
        err = f"Unexpected error during deployment: {exc}"
        log.err(err)
        result.errors.append(err)

    log.finish(result.success)
    result.log_text = log.text_truncated
    return result
