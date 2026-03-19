from sqlalchemy import Column, Integer, String, Text, DateTime
from datetime import datetime, timezone
from ..database import Base


class Rulebook(Base):
    __tablename__ = "rulebooks"
    id             = Column(Integer, primary_key=True, index=True)
    component_type = Column(String(50), unique=True, nullable=False)  # apex_class, apex_trigger, lwc, aura, flow
    title          = Column(String(200), nullable=False)
    system_prompt  = Column(Text, nullable=False, default="")
    rules          = Column(Text, nullable=False, default="")
    updated_at     = Column(DateTime, default=lambda: datetime.now(timezone.utc))


# ── Default rulebook content (seeded on first request) ─────────────────────────

DEFAULT_RULEBOOKS = {
    "apex_class": {
        "title": "Apex Class → C# IPlugin / Service Class",
        "system_prompt": (
            "You are an expert Salesforce to Microsoft Dynamics 365 migration engineer. "
            "Convert Salesforce Apex classes to idiomatic C# for Dynamics 365 / Dataverse. "
            "Use IPlugin for business logic, standalone service classes for utilities. "
            "Always produce complete, compilable C# with XML doc comments."
        ),
        "rules": """\
MANDATORY CONVERSION RULES — APEX CLASS → C# IPlugin / SERVICE CLASS

1. USINGS (always include):
   using System;
   using System.Collections.Generic;
   using Microsoft.Xrm.Sdk;
   using Microsoft.Xrm.Sdk.Query;
   using Microsoft.Xrm.Sdk.Messages;

2. CLASS STRUCTURE:
   - Do NOT wrap code in a namespace block
   - Implement IPlugin: public class {ClassName} : IPlugin
   - Single method: public void Execute(IServiceProvider serviceProvider)
   - Extract IPluginExecutionContext, IOrganizationServiceFactory, IOrganizationService, ITracingService

3. RECURSION GUARD (mandatory first line in Execute):
   if (context.Depth > 1) return;

4. FIELD ACCESS — always guard with Contains():
   if (entity.Contains("field_name")) { var val = entity["field_name"]; }

5. QUERY EXPRESSION:
   - Convert SOQL to QueryExpression with ColumnSet and FilterExpression
   - Use Criteria.AddCondition() for WHERE clauses
   - Use LinkEntity for SOQL JOIN / relationship queries

6. DATA TYPES:
   - Picklist / OptionSet fields → OptionSetValue (int code from field mapping)
   - Lookup / Reference fields  → EntityReference("entity_logical_name", Guid)
   - Currency fields            → Money(decimal)
   - DateTime                  → DateTime (UTC)

7. DML OPERATIONS:
   - insert → service.Create(entity)
   - update → service.Update(entity)
   - delete → service.Delete(logicalName, id)
   - upsert → UpsertRequest

8. FIELD NAMES — use Dataverse_Column from the field mapping JSON:
   - Custom fields: use Dataverse_Column exactly as provided
   - Standard D365 SDK lookup fields: parentcustomerid, ownerid, regardingobjectid, etc.
   - NEVER use Salesforce API names (e.g. Account__c, Contact__r)

9. ERROR HANDLING:
   - Use InvalidPluginExecutionException for validation failures shown to user
   - Use ITracingService.Trace() for diagnostic logging

10. END WITH migration notes section listing any manual steps required.\
""",
    },
    "apex_trigger": {
        "title": "Apex Trigger → C# IPlugin (Pre/PostOperation)",
        "system_prompt": (
            "You are an expert Salesforce to Microsoft Dynamics 365 migration engineer. "
            "Convert Salesforce Apex triggers to C# IPlugin implementations registered "
            "as Pre/PostOperation event handlers on Dynamics 365 / Dataverse entities. "
            "Produce complete, compilable C# with XML doc comments."
        ),
        "rules": """\
MANDATORY CONVERSION RULES — APEX TRIGGER → C# IPlugin

1. USINGS:
   using System;
   using System.Collections.Generic;
   using Microsoft.Xrm.Sdk;
   using Microsoft.Xrm.Sdk.Query;
   using Microsoft.Xrm.Sdk.Messages;

2. TRIGGER → STAGE MAPPING:
   before insert / before update → Stage = 20 (Pre-Operation)
   after insert / after update   → Stage = 40 (Post-Operation)
   before delete                 → Stage = 20
   after delete                  → Stage = 40

3. TARGET ENTITY:
   var target = (Entity)context.InputParameters["Target"];

4. PRE/POST IMAGES:
   var preImage  = context.PreEntityImages.Contains("PreImage")  ? context.PreEntityImages["PreImage"]  : null;
   var postImage = context.PostEntityImages.Contains("PostImage") ? context.PostEntityImages["PostImage"] : null;

5. RECURSION GUARD (mandatory):
   if (context.Depth > 1) return;

6. FIELD ACCESS — always guard with Contains():
   if (target.Contains("field_name")) { ... }

7. STANDARD D365 LOOKUP ATTRIBUTE NAMES (use SDK names, NOT field mapping names):
   Contact → Account parent  : "parentcustomerid"
   Account → parent account  : "parentaccountid"
   Any → owner               : "ownerid"
   Activity → regarding      : "regardingobjectid"
   Opportunity → Account     : "customerid"

8. CUSTOM FIELD NAMES — use Dataverse_Column from field mapping JSON:
   - All custom / migrated fields must use Dataverse_Column exactly
   - NEVER use Salesforce API names (e.g. Custom_Field__c)

9. PICKLIST / OPTIONSET FIELDS:
   - Use OptionSetValue with the integer DY_picklist code from picklist mapping
   - Example: entity["new_status"] = new OptionSetValue(100000000);

10. DML → SDK CALLS:
    insert → service.Create(entity)
    update → service.Update(entity)
    delete → service.Delete(logicalName, id)

11. TRIGGER CONTEXT CHECKS:
    Trigger.isInsert → context.MessageName == "Create"
    Trigger.isUpdate → context.MessageName == "Update"
    Trigger.isDelete → context.MessageName == "Delete"
    Trigger.isBefore → context.Stage == 20
    Trigger.isAfter  → context.Stage == 40

12. ERROR HANDLING:
    throw new InvalidPluginExecutionException("message"); // for user-visible errors
    tracingService.Trace("debug info"); // for diagnostics\
""",
    },
    "lwc": {
        "title": "LWC → PCF TypeScript Component",
        "system_prompt": (
            "You are an expert Salesforce to Microsoft Power Apps (PCF) migration engineer. "
            "Convert Lightning Web Components (LWC) to Power Apps Component Framework (PCF) "
            "TypeScript components. Produce complete TypeScript implementing StandardControl<IInputs, IOutputs>."
        ),
        "rules": """\
MANDATORY CONVERSION RULES — LWC → PCF TypeScript

1. STRUCTURE:
   - Implement StandardControl<IInputs, IOutputs>
   - Four lifecycle methods: init(), updateView(), getOutputs(), destroy()
   - Map @api properties → IInputs interface fields
   - Map dispatched events → IOutputs interface fields + notifyOutputChanged()

2. DATA BINDING:
   - @wire (getRecord) → PCF WebApi: Xrm.WebApi.retrieveRecord(entityType, id, select)
   - @wire (getPicklistValues) → Load option set metadata dynamically
   - LDS (lightning/uiRecordApi) → Xrm.WebApi calls

3. PICKLIST / OPTIONSET:
   - Use INTEGER option codes (DY_picklist value from picklist mapping), NOT string labels
   - Load available options: Xrm.Utility.getEntityMetadata(entityName, [fieldName])
   - Example: optionValue = 100000000 (NOT "Active")

4. ENTITY / FIELD NAMES:
   - Use Dataverse_Column from field mapping for all field references
   - Entity logical name from Dynamics_Object in field mapping
   - Primary key pattern: entity "new_xyz" → key field "new_xyzid"
   - All WebApi calls use Dataverse field names (NOT Salesforce API names)

5. API CALLS:
   - Xrm.WebApi.retrieveMultipleRecords(entityType, options)
   - Xrm.WebApi.createRecord(entityType, data)
   - Xrm.WebApi.updateRecord(entityType, id, data)
   - Xrm.WebApi.deleteRecord(entityType, id)

6. EVENTS:
   - LWC custom events → PCF notifyOutputChanged() + IOutputs property
   - Use context.mode.trackContainerResize() for responsive behavior

7. TEMPLATE:
   - Replace HTML template with DOM manipulation in TypeScript
   - Use document.createElement() or innerHTML for rendering\
""",
    },
    "aura": {
        "title": "Aura Component → PCF TypeScript Component",
        "system_prompt": (
            "You are an expert Salesforce to Microsoft Power Apps (PCF) migration engineer. "
            "Convert Aura (Lightning) components to Power Apps Component Framework (PCF) "
            "TypeScript components. Produce complete TypeScript implementing StandardControl<IInputs, IOutputs>."
        ),
        "rules": """\
MANDATORY CONVERSION RULES — AURA → PCF TypeScript

1. STRUCTURE:
   - Implement StandardControl<IInputs, IOutputs>
   - Map Aura attributes → IInputs properties
   - Map Aura events → IOutputs + notifyOutputChanged()
   - Lifecycle: init() replaces afterRender/doInit, destroy() replaces unrender

2. AURA → PCF MAPPING:
   - force:recordData       → Xrm.WebApi.retrieveRecord()
   - lightning:card         → DOM div with MSFT Fluent UI classes
   - lightning:button       → HTML button element
   - lightning:inputField   → HTML input + Xrm field binding
   - aura:iteration         → Array.map() in TypeScript

3. ENTITY / FIELD NAMES:
   - Use Dataverse_Column from field mapping for all field references
   - Entity logical name from Dynamics_Object in field mapping
   - Primary key pattern: entity "new_xyz" → key field "new_xyzid"

4. PICKLIST / OPTIONSET:
   - Use integer DY_picklist codes (from picklist mapping), NOT string labels
   - Load options dynamically: Xrm.Utility.getEntityMetadata()

5. DATA OPERATIONS:
   - Aura callout/apex → Xrm.WebApi calls
   - Aura storable actions → Xrm.WebApi with caching
   - All field names use Dataverse_Column from field mapping

6. EVENTS:
   - Aura application events → PCF context.events (if available) or custom DOM events
   - Aura component events   → notifyOutputChanged() with IOutputs update\
""",
    },
    "flow": {
        "title": "Salesforce Flow → Power Automate Cloud Flow (JSON)",
        "system_prompt": (
            "You are a Salesforce-to-Power Automate migration expert. "
            "Detect flow type from process_type + trigger_type: "
            "process_type=Flow + trigger_type=null = Screen Flow (Manual Button trigger, NOT Canvas App); "
            "process_type=AutoLaunchedFlow + trigger_type=RecordAfterSave = Record-Triggered After-Save (Dataverse row trigger); "
            "process_type=AutoLaunchedFlow + trigger_type=RecordBeforeSave = Before-Save (document as Dataverse Plugin — no PA equivalent); "
            "process_type=AutoLaunchedFlow + trigger_type=Scheduled = Scheduled (Recurrence trigger); "
            "process_type=AutoLaunchedFlow + trigger_type=null = Auto-launched subflow (Manual Button trigger); "
            "SCREEN FLOW screen field mapping: "
            "fieldType=InputField dataType=String->string, Number->integer, Currency->number, Boolean->boolean; "
            "fieldType=DropdownBox->string; fieldType=DisplayText/DisplayImage/RegionContainer/Region->SKIP. "
            "Screen field 'name' property becomes the exact trigger_inputs parameter key. "
            "ELEMENT MAPPING: "
            "RecordCreate->AddRow (table_name + row with simple @{triggerBody()?['field']} refs); "
            "RecordUpdate->UpdateRow; RecordLookup->GetRow or ListRows; RecordDelete->DeleteRow; "
            "Decision->Condition; Assignment->SetVariable/InitializeVariable; Loop->Foreach; "
            "ActionCall emailSimple->SendEmail; Subflow->RunChildFlow; "
            "CRITICAL: AddRow row values MUST be simple @{triggerBody()?['name']} references ONLY — no if(), no equals(). "
            "Include new_dynamiccheckbox=false in every Account AddRow action. "
            "Return ONLY valid JSON inside <converted>...</converted> — no prose outside tags."
        ),
        "rules": """\
SALESFORCE FLOW → POWER AUTOMATE STRUCTURED JSON CONVERSION RULES

══════════════════════════════════════════════════════════════
SECTION 1 — FLOW TYPE DETECTION
══════════════════════════════════════════════════════════════

DETECTION TABLE (from process_type + trigger_type):
  process_type=Flow, trigger_type=null              → Screen Flow     → flow_type=Manual
  process_type=AutoLaunchedFlow, RecordAfterSave    → Automated       → flow_type=Automated
  process_type=AutoLaunchedFlow, RecordBeforeSave   → Before-Save     → flow_type=Automated + notes
  process_type=AutoLaunchedFlow, Scheduled          → Scheduled       → flow_type=Scheduled
  process_type=AutoLaunchedFlow, null               → Auto-launched   → flow_type=Instant
  process_type=Orchestrator                         → Orchestration   → flow_type=Automated

trigger_event values: Added | Modified | Deleted | Added or Modified | Scheduled | Manual | HTTP

══════════════════════════════════════════════════════════════
SECTION 2 — TRIGGER INPUTS (Screen Flows)
══════════════════════════════════════════════════════════════

Screen field type mapping (fieldType + dataType → trigger_inputs type):
  InputField + String      → "string"
  InputField + Number      → "integer"
  InputField + Currency    → "number"
  InputField + Boolean     → "boolean"
  InputField + Date/DateTime → "string"
  LargeTextArea            → "string"
  DropdownBox / RadioButtons → "string"
  DisplayText / DisplayImage / RegionContainer / Region → SKIP

Screen field "name" property → trigger_inputs key (exact same name, case-preserved)

══════════════════════════════════════════════════════════════
SECTION 3 — ACTION MAPPING
══════════════════════════════════════════════════════════════

  RecordCreate  → action_type: AddRow      (CreateRecord)
  RecordUpdate  → action_type: UpdateRow   (UpdateRecord)
  RecordLookup  → action_type: GetRow      (GetItem) or ListRows (ListRecords)
  RecordDelete  → action_type: DeleteRow   (DeleteRecord)
  Decision      → action_type: Condition
  Assignment    → action_type: SetVariable or InitializeVariable
  Loop          → action_type: Foreach
  emailAlert    → action_type: SendEmail
  Subflow       → action_type: RunChildFlow
  Wait          → action_type: Delay or DelayUntil

AddRow row values MUST use SIMPLE @{triggerBody()?['fieldName']} references ONLY.
NO if(), NO equals(), NO nested expressions.
Include "new_dynamiccheckbox": false in every Account AddRow action.

══════════════════════════════════════════════════════════════
SECTION 4 — FIELD NAME RULES
══════════════════════════════════════════════════════════════

  Use Dataverse_Column from MANDATORY FIELD MAPPING for all field references.
  Use Dynamics_Object logical name for table_name (e.g. "accounts", "contacts").
  Standard mapping: Account→accounts, Contact→contacts, Opportunity→opportunities, Case→incidents
  NEVER use Salesforce API names (no __c suffix fields).
  Choice/OptionSet → integer value from DY_picklist (NOT string labels).

══════════════════════════════════════════════════════════════
SECTION 5 — FORMULA → EXPRESSION MAPPING
══════════════════════════════════════════════════════════════

  TODAY()    → utcNow('yyyy-MM-dd')    NOW()  → utcNow()
  TEXT(v)    → string(variables('v'))  LEN → length()  UPPER → toUpper()
  IF(c,t,f)  → if(condition, t, f)     AND → and()     OR → or()
  a=b → equals(a,b)  a>b → greater(a,b)  a<>b → not(equals(a,b))
  $Record.FieldName → @{triggerBody()?['fieldlogicalname']}

══════════════════════════════════════════════════════════════
SECTION 6 — OUTPUT JSON STRUCTURE (return ONLY this exact shape)
══════════════════════════════════════════════════════════════

{
  "flow_name": "Account_Creation",
  "flow_type": "Manual",
  "trigger_table": "none",
  "trigger_event": "Manual",
  "description": "Plain English description",
  "power_automate_summary": "Step-by-step plain English migration notes",
  "trigger_inputs": {
    "Account_Name": {"type": "string", "description": "Account name entered by user"},
    "CurrencyISO":  {"type": "string", "description": "Currency ISO code"}
  },
  "actions": [
    {
      "step": 1,
      "name": "Create_Account",
      "action_type": "AddRow",
      "description": "Create new Account record in Dataverse",
      "inputs": {
        "table_name": "accounts",
        "row": {
          "name":                "@{triggerBody()?['Account_Name']}",
          "new_currencyisocode": "@{triggerBody()?['CurrencyISO']}",
          "new_dynamiccheckbox": false
        }
      },
      "outputs": {}
    }
  ],
  "manual_steps": ["One-time: Open flow in Power Automate portal, authorize Dataverse connection, Save, then Turn On"],
  "notes": "Migration notes"
}

CRITICAL: Return ONLY valid JSON inside <converted>...</converted>. No markdown. No prose outside tags.\
""",
    },
}
