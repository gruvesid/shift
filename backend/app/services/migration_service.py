from typing import List, Dict

# Realistic stub mappings keyed by SalesForce_Object name.
# These simulate rows from raw.object_mappings JOIN raw.field_mappings.
# Replace the body of get_lakehouse_field_mappings() with real SQL once
# the Fabric Lakehouse SQL endpoint is configured.
STUB_MAPPINGS: Dict[str, List[Dict]] = {
    "Account": [
        {"sf_label": "Account Name",    "sf_api": "Name",              "sf_type": "Text",
         "d365_name": "Account Name",   "d365_api": "name",            "d365_type": "String"},
        {"sf_label": "Billing Street",  "sf_api": "BillingStreet",     "sf_type": "TextArea",
         "d365_name": "Address 1: Street 1", "d365_api": "address1_line1", "d365_type": "String"},
        {"sf_label": "Billing City",    "sf_api": "BillingCity",       "sf_type": "Text",
         "d365_name": "Address 1: City", "d365_api": "address1_city",  "d365_type": "String"},
        {"sf_label": "Billing Country", "sf_api": "BillingCountry",    "sf_type": "Text",
         "d365_name": "Address 1: Country/Region", "d365_api": "address1_country", "d365_type": "String"},
        {"sf_label": "Phone",           "sf_api": "Phone",             "sf_type": "Phone",
         "d365_name": "Main Phone",     "d365_api": "telephone1",      "d365_type": "String"},
        {"sf_label": "Website",         "sf_api": "Website",           "sf_type": "URL",
         "d365_name": "Website",        "d365_api": "websiteurl",      "d365_type": "String"},
        {"sf_label": "Annual Revenue",  "sf_api": "AnnualRevenue",     "sf_type": "Currency",
         "d365_name": "Annual Revenue", "d365_api": "revenue",         "d365_type": "Money"},
    ],
    "Contact": [
        {"sf_label": "First Name",      "sf_api": "FirstName",         "sf_type": "Text",
         "d365_name": "First Name",     "d365_api": "firstname",       "d365_type": "String"},
        {"sf_label": "Last Name",       "sf_api": "LastName",          "sf_type": "Text",
         "d365_name": "Last Name",      "d365_api": "lastname",        "d365_type": "String"},
        {"sf_label": "Email",           "sf_api": "Email",             "sf_type": "Email",
         "d365_name": "Email",          "d365_api": "emailaddress1",   "d365_type": "String"},
        {"sf_label": "Phone",           "sf_api": "Phone",             "sf_type": "Phone",
         "d365_name": "Business Phone", "d365_api": "telephone1",      "d365_type": "String"},
        {"sf_label": "Mobile",          "sf_api": "MobilePhone",       "sf_type": "Phone",
         "d365_name": "Mobile Phone",   "d365_api": "mobilephone",     "d365_type": "String"},
        {"sf_label": "Title",           "sf_api": "Title",             "sf_type": "Text",
         "d365_name": "Job Title",      "d365_api": "jobtitle",        "d365_type": "String"},
        {"sf_label": "Department",      "sf_api": "Department",        "sf_type": "Text",
         "d365_name": "Department",     "d365_api": "department",      "d365_type": "String"},
    ],
    "Custom__c": [
        {"sf_label": "Field 1",         "sf_api": "Field1__c",         "sf_type": "Text",
         "d365_name": "Custom Field 1", "d365_api": "cr123_customfield1", "d365_type": "String"},
        {"sf_label": "Field 2",         "sf_api": "Field2__c",         "sf_type": "Number",
         "d365_name": "Custom Field 2", "d365_api": "cr123_customfield2", "d365_type": "Integer"},
    ],
}


class MigrationService:
    def __init__(self):
        self.object_flags: Dict[str, bool] = {}
        self.field_mappings: Dict[str, List[Dict]] = {}

    def set_migrate_flag(self, object_name: str, flag: bool):
        self.object_flags[object_name] = flag

    def get_migrate_objects(self) -> List[str]:
        return [o for o, v in self.object_flags.items() if v]

    def set_field_mapping(self, object_name: str, mapping: List[Dict]):
        self.field_mappings[object_name] = mapping

    def get_field_mapping(self, object_name: str) -> List[Dict]:
        return self.field_mappings.get(object_name, [])

    def get_lakehouse_field_mappings(self, sf_object: str) -> List[Dict]:
        """
        Query raw.object_mappings JOIN raw.field_mappings by SalesForce_Object.

        Replace stub below with real SQL once the Fabric Lakehouse SQL endpoint
        is available, e.g. using pyodbc / SQLAlchemy:

            conn = pyodbc.connect(LAKEHOUSE_CONNECTION_STRING)
            cursor = conn.cursor()
            cursor.execute(
                '''
                SELECT fm.[Dynamics_Field_Name], fm.[Dynamics_API_Name],
                       fm.[Dynamics_Data_Type],  fm.[Salesforce_Field_Label],
                       fm.[Salesforce_API_Name], fm.[Salesforce_Data_Type]
                FROM [raw].[field_mappings]  fm
                JOIN [raw].[object_mappings] om ON om.[UID] = fm.[UID]
                WHERE om.[SalesForce_Object] = ?
                ''',
                sf_object
            )
            rows = cursor.fetchall()
            return [
                {
                    "sf_label": r.Salesforce_Field_Label,
                    "sf_api":   r.Salesforce_API_Name,
                    "sf_type":  r.Salesforce_Data_Type,
                    "d365_name": r.Dynamics_Field_Name,
                    "d365_api":  r.Dynamics_API_Name,
                    "d365_type": r.Dynamics_Data_Type,
                }
                for r in rows
            ]
        """
        return STUB_MAPPINGS.get(sf_object, [])

    def start_migration(self, objects: List[str]):
        return {obj: 0 for obj in objects}
