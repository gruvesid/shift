"""
Email service — SMTP with HTML templates.
Sends OTPs, activation links, trial notifications, approval/rejection emails.
"""
import os
import smtplib
import logging
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

log = logging.getLogger(__name__)

SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "gruvesid@gmail.com")
SMTP_PASS = os.environ.get("SMTP_PASS", "umvtbzzhaozixfcs")
SMTP_FROM = os.environ.get("SMTP_FROM", "OrbitNotification <gruvesid@gmail.com>")
APP_URL   = os.environ.get("APP_URL", "http://localhost:3008")
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "siddhrajsinh.atodaria@gruve.ai")

# ── Brand colors ──────────────────────────────────────────────────────────────
_BRAND   = "#23a55a"
_BRAND_D = "#1a7d44"
_BG      = "#0d1117"
_CARD    = "#161b22"
_TEXT    = "#e6edf3"
_MUTED   = "#8b949e"


def _base_template(title: str, body_html: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>{title}</title>
</head>
<body style="margin:0;padding:0;background:{_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:{_BG};min-height:100vh;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:{_CARD};border-radius:12px;border:1px solid #30363d;overflow:hidden;max-width:560px;width:100%;">
        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#1a2332 0%,#0d1117 100%);padding:28px 32px;border-bottom:1px solid #30363d;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td>
                  <span style="font-size:20px;font-weight:700;color:{_TEXT};letter-spacing:-0.5px;">
                    <span style="color:{_BRAND};">●</span> SF→D365 Migration Wizard
                  </span>
                  <div style="font-size:11px;color:{_MUTED};margin-top:2px;">by Gruve AI</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:32px;">
            {body_html}
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:16px 32px 24px;border-top:1px solid #21262d;">
            <p style="margin:0;font-size:11px;color:{_MUTED};text-align:center;">
              This email was sent by SF→D365 Migration Wizard &middot; Gruve AI<br/>
              If you didn't request this, you can safely ignore this email.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>"""


def _send(to_email: str, subject: str, html: str, text: str = "") -> bool:
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"]    = SMTP_FROM
        msg["To"]      = to_email
        if text:
            msg.attach(MIMEText(text, "plain"))
        msg.attach(MIMEText(html, "html"))
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as srv:
            srv.ehlo()
            srv.starttls()
            srv.login(SMTP_USER, SMTP_PASS)
            srv.sendmail(SMTP_USER, to_email, msg.as_string())
        log.info(f"[EMAIL] Sent '{subject}' → {to_email}")
        return True
    except Exception as exc:
        log.error(f"[EMAIL ERROR] {to_email}: {exc}")
        return False


# ── OTP Email ─────────────────────────────────────────────────────────────────

def send_otp_email(to_email: str, otp: str, purpose: str) -> bool:
    if purpose == "reset-password":
        title    = "Reset Your Password"
        headline = "Password Reset Code"
        desc     = "Use the code below to reset your password. It expires in <strong>10 minutes</strong>."
    else:
        title    = "Verify Your Email"
        headline = "Email Verification Code"
        desc     = "Use the code below to verify your email address. It expires in <strong>10 minutes</strong>."

    body = f"""
      <h2 style="margin:0 0 8px;font-size:22px;font-weight:700;color:{_TEXT};">{headline}</h2>
      <p style="margin:0 0 28px;font-size:14px;color:{_MUTED};line-height:1.6;">{desc}</p>

      <div style="background:#0d1117;border:2px solid {_BRAND};border-radius:12px;padding:28px;text-align:center;margin-bottom:28px;">
        <div style="font-size:42px;font-weight:800;letter-spacing:12px;color:{_BRAND};font-family:monospace;">{otp}</div>
        <div style="font-size:12px;color:{_MUTED};margin-top:10px;">Valid for 10 minutes &middot; Do not share</div>
      </div>

      <p style="margin:0;font-size:13px;color:{_MUTED};">
        If you didn't request this code, your account may be at risk.
        Please contact support immediately.
      </p>
    """
    html = _base_template(title, body)
    return _send(to_email, f"[SF→D365] {title}: {otp}", html,
                 f"{headline}\n\nYour OTP: {otp}\nExpires in 10 minutes.")


# ── Activation Email ──────────────────────────────────────────────────────────

def send_activation_email(to_email: str, name: str, token: str, trial_days: int = 30) -> bool:
    link = f"{APP_URL}/#activate?token={token}"
    body = f"""
      <h2 style="margin:0 0 8px;font-size:22px;font-weight:700;color:{_TEXT};">
        Welcome, {name}! 🎉
      </h2>
      <p style="margin:0 0 20px;font-size:14px;color:{_MUTED};line-height:1.6;">
        Your trial access to SF→D365 Migration Wizard has been <strong style="color:{_BRAND};">approved</strong>.
        You have <strong style="color:{_TEXT};">{trial_days} days</strong> of full access.
      </p>
      <p style="margin:0 0 28px;font-size:14px;color:{_MUTED};">
        Click the button below to set your password and activate your account.
        This link expires in <strong>72 hours</strong>.
      </p>

      <div style="text-align:center;margin-bottom:28px;">
        <a href="{link}" style="display:inline-block;background:{_BRAND};color:#fff;text-decoration:none;
           padding:14px 36px;border-radius:8px;font-size:15px;font-weight:600;letter-spacing:0.3px;">
          Activate My Account →
        </a>
      </div>

      <div style="background:#0d1117;border-radius:8px;padding:14px 16px;margin-bottom:16px;">
        <div style="font-size:11px;color:{_MUTED};margin-bottom:4px;">Or copy this link:</div>
        <div style="font-size:11px;color:{_BRAND};word-break:break-all;font-family:monospace;">{link}</div>
      </div>

      <p style="margin:0;font-size:12px;color:{_MUTED};">
        Your trial includes all premium features. No credit card required.
      </p>
    """
    html = _base_template("Account Activation", body)
    return _send(to_email, "[SF→D365] Your trial is approved — activate your account", html,
                 f"Welcome {name}! Activate your account: {link}")


# ── Trial Request Notification (to admin) ─────────────────────────────────────

def send_trial_request_admin(name: str, email: str, company: str, message: str) -> bool:
    review_url = f"{APP_URL}/#admin/users"
    company_str = company or "Not provided"
    message_str = message or "No message provided"
    body = f"""
      <h2 style="margin:0 0 8px;font-size:22px;font-weight:700;color:{_TEXT};">
        New Trial Request
      </h2>
      <p style="margin:0 0 24px;font-size:14px;color:{_MUTED};">
        A new trial request has been submitted. Review and approve or reject below.
      </p>

      <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117;border-radius:8px;margin-bottom:24px;overflow:hidden;">
        <tr>
          <td style="padding:14px 16px;border-bottom:1px solid #21262d;">
            <div style="font-size:11px;color:{_MUTED};margin-bottom:3px;">NAME</div>
            <div style="font-size:14px;color:{_TEXT};font-weight:600;">{name}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:14px 16px;border-bottom:1px solid #21262d;">
            <div style="font-size:11px;color:{_MUTED};margin-bottom:3px;">EMAIL</div>
            <div style="font-size:14px;color:{_BRAND};font-family:monospace;">{email}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:14px 16px;border-bottom:1px solid #21262d;">
            <div style="font-size:11px;color:{_MUTED};margin-bottom:3px;">COMPANY</div>
            <div style="font-size:14px;color:{_TEXT};">{company_str}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:14px 16px;">
            <div style="font-size:11px;color:{_MUTED};margin-bottom:3px;">MESSAGE</div>
            <div style="font-size:13px;color:{_TEXT};line-height:1.5;">{message_str}</div>
          </td>
        </tr>
      </table>

      <div style="text-align:center;">
        <a href="{review_url}" style="display:inline-block;background:{_BRAND};color:#fff;text-decoration:none;
           padding:12px 28px;border-radius:8px;font-size:14px;font-weight:600;">
          Review in Admin Panel →
        </a>
      </div>
    """
    html = _base_template("New Trial Request", body)
    return _send(ADMIN_EMAIL, f"[SF→D365] Trial Request from {name} ({email})", html,
                 f"New trial request from {name} ({email}) - Company: {company_str}")


# ── Approval / Rejection Emails ───────────────────────────────────────────────

def send_rejection_email(to_email: str, name: str, reason: str = "") -> bool:
    reason_block = ""
    if reason:
        reason_block = f"""
        <div style="background:#0d1117;border-left:3px solid #f85149;border-radius:0 8px 8px 0;padding:14px 16px;margin:16px 0;">
          <div style="font-size:11px;color:{_MUTED};margin-bottom:4px;">REASON</div>
          <div style="font-size:13px;color:{_TEXT};">{reason}</div>
        </div>"""
    body = f"""
      <h2 style="margin:0 0 8px;font-size:22px;font-weight:700;color:{_TEXT};">
        Trial Request Update
      </h2>
      <p style="margin:0 0 16px;font-size:14px;color:{_MUTED};line-height:1.6;">
        Hi {name}, thank you for your interest in SF→D365 Migration Wizard.
      </p>
      <p style="margin:0 0 8px;font-size:14px;color:{_TEXT};">
        Unfortunately, we are unable to approve your trial request at this time.
      </p>
      {reason_block}
      <p style="margin:16px 0 0;font-size:13px;color:{_MUTED};">
        If you believe this is a mistake or would like to discuss further,
        please contact us at <a href="mailto:{ADMIN_EMAIL}" style="color:{_BRAND};">{ADMIN_EMAIL}</a>.
      </p>
    """
    html = _base_template("Trial Request Update", body)
    return _send(to_email, "[SF→D365] Your trial request status update", html,
                 f"Hi {name}, your trial request was not approved at this time.")


def send_password_changed_email(to_email: str, name: str) -> bool:
    body = f"""
      <h2 style="margin:0 0 8px;font-size:22px;font-weight:700;color:{_TEXT};">
        Password Changed
      </h2>
      <p style="margin:0 0 16px;font-size:14px;color:{_MUTED};line-height:1.6;">
        Hi {name}, your password was successfully changed.
      </p>
      <p style="margin:0;font-size:13px;color:{_MUTED};">
        If you did not make this change, please contact support immediately at
        <a href="mailto:{ADMIN_EMAIL}" style="color:{_BRAND};">{ADMIN_EMAIL}</a>.
      </p>
    """
    html = _base_template("Password Changed", body)
    return _send(to_email, "[SF→D365] Your password has been changed", html,
                 f"Hi {name}, your password was successfully changed.")
