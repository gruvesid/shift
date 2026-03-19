import React, { useState, useCallback, useEffect } from 'react';
import LoginPage from './components/LoginPage';
import AdminUsersPage from './components/AdminUsersPage';

/* ── Sidebar Nav Icons ───────────────────────────────────────────────── */
function IconDataMigration({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v4c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
      <path d="M3 9v4c0 1.66 4.03 3 9 3s9-1.34 9-3V9" />
      <path d="M3 13v4c0 1.66 4.03 3 9 3s9-1.34 9-3v-4" />
    </svg>
  );
}

function IconMetadata({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h16M4 10h16M4 14h10M4 18h6" />
      <circle cx="19" cy="16" r="3" />
      <path d="M19 13v-1M19 20v-1M22 16h1M16 16h-1M21.1 14.1l.7-.7M17.2 17.9l-.7.7M21.1 17.9l.7.7M17.2 14.1l-.7-.7" strokeWidth="1.5" />
    </svg>
  );
}

function IconLLM({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a4 4 0 0 1 4 4c0 1.5-.8 2.8-2 3.5V11h-4V9.5A4 4 0 0 1 8 6a4 4 0 0 1 4-4z" />
      <rect x="8" y="11" width="8" height="5" rx="1" />
      <path d="M9 16v2M12 16v3M15 16v2" />
      <path d="M6 8H4a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2M18 8h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-2" />
    </svg>
  );
}

function IconVector({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5" cy="5" r="2" />
      <circle cx="19" cy="5" r="2" />
      <circle cx="5" cy="19" r="2" />
      <circle cx="19" cy="19" r="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M7 5h10M5 7v10M7 19h10M19 7v10M7 7l4 4M17 7l-4 4M7 17l4-4M17 17l-4-4" strokeWidth="1.4" strokeOpacity="0.7" />
    </svg>
  );
}

function IconCodeConverter({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
      <path d="M12 2v20" strokeWidth="1.4" strokeOpacity="0.5" />
    </svg>
  );
}

function IconLLMUsage({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
      <line x1="2" y1="20" x2="22" y2="20" />
    </svg>
  );
}

function IconDeployLogs({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}
import './App.css';
import './converter-usage.css';
import ConnectionTab from './components/ConnectionTab';
import ObjectsTab from './components/ObjectsTab';
import MappingTab from './components/MappingTab';
import MigrationTab from './components/MigrationTab';
import ShiftTab from './components/ShiftTab';
import LLMConnectorPage from './components/LLMConnectorPage';
import VectorConnectorPage from './components/VectorConnectorPage';
import CodeConverterPage from './components/CodeConverterPage';
import LLMUsagePage from './components/LLMUsagePage';
import DeployLogsPage from './components/DeployLogsPage';
import DeploymentPlanPage from './components/DeploymentPlanPage';
import AgentChatPage from './components/AgentChatPage';

const DATA_STEPS = [
  { id: 'connection', label: 'Connection', icon: '🔗', step: 1 },
  { id: 'objects', label: 'Objects', icon: '📦', step: 2 },
  { id: 'mapping', label: 'Mapping', icon: '🗺️', step: 3 },
  { id: 'schema_migration', label: 'Schema Migration', icon: '📝', step: 4 },
  { id: 'data_migration', label: 'Data Migration', icon: '🚀', step: 5 },
];

const STORAGE_KEYS = {
  mainTab:             'sf2d_main_tab',
  tab:                 'sf2d_tab',
  confirmed:           'sf2d_confirmed',
  objects:             'sf2d_objects',
  collapsed:           'sf2d_sidebar_collapsed',
  converterOrgId:      'sf2d_converter_org_id',
  deploymentOrgId:     'sf2d_deployment_org_id',
  deploymentOrgName:   'sf2d_deployment_org_name',
  metadataDetailOrgId: 'sf2d_metadata_detail_org_id',
  theme:               'sf2d_theme',
};

function readStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw !== null ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

/* ── App Guide Panel ─────────────────────────────────────────────────── */
const GUIDE_SECTIONS = [
  {
    color: '#23a55e',
    iconSvg: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20M12 2a14.5 14.5 0 0 1 0 20M2 12h20"/>
      </svg>
    ),
    title: 'How This App Works',
    subtitle: 'End-to-end Salesforce → Dynamics 365 migration pipeline',
    steps: [
      { num: '1', label: 'Connect', desc: 'Link your Salesforce org using Consumer Key/Secret + Security Token and your Dynamics 365 tenant via Azure AD (Client ID, Client Secret, Tenant ID).' },
      { num: '2', label: 'Extract Metadata', desc: 'Pull Apex Classes, Triggers, Flows, Lightning Web Components (LWC), and Aura Components from Salesforce into a local SQLite database.' },
      { num: '3', label: 'AI Code Conversion', desc: 'Each Salesforce component is sent to an LLM (OpenAI / Claude / Cohere) with a D365-specific rulebook. The model generates equivalent C# Plugin code or Power Automate flows.' },
      { num: '4', label: 'Validate & Edit', desc: 'Run a second LLM pass to catch errors, logical issues, and API mismatches. Edit the generated code inline before committing.' },
      { num: '5', label: 'Deploy to D365', desc: 'Compile the C# plugin via dotnet CLI, register it in the D365 Plugin Registration Tool, and confirm the assembly/resource ID is live.' },
    ],
  },
  {
    color: '#3b82f6',
    iconSvg: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v4c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 9v4c0 1.66 4.03 3 9 3s9-1.34 9-3V9"/><path d="M3 13v4c0 1.66 4.03 3 9 3s9-1.34 9-3v-4"/>
      </svg>
    ),
    title: 'Data Migration',
    subtitle: 'Move Salesforce object records into Dynamics 365 in 5 steps',
    steps: [
      { num: '①', label: 'Connection', desc: 'Enter your Salesforce instance URL, username, password, and security token. Provide D365 org URL, Client ID, and Client Secret. Test both connections before proceeding.' },
      { num: '②', label: 'Objects', desc: 'Browse all Salesforce standard and custom objects. Search, filter, and select which ones to migrate. Multi-select with checkboxes. Confirm selection to lock them in.' },
      { num: '③', label: 'Mapping', desc: 'Automatically maps Salesforce field names to D365 equivalents using AI suggestions. Review each field mapping, override mismatches, and flag required fields. Fabric Lakehouse integration available for field schema discovery.' },
      { num: '④', label: 'Schema Migration', desc: 'Applies the mapped field schema to your D365 environment — creates or updates entity attributes. Run history tracks each schema apply operation.' },
      { num: '⑤', label: 'Data Migration', desc: 'Reads records from Salesforce in batches, transforms them per the field mappings, and upserts into D365. Progress bar, record count, and error log are shown in real-time.' },
    ],
  },
  {
    color: '#8b5cf6',
    iconSvg: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 6h16M4 10h16M4 14h10M4 18h6"/><circle cx="19" cy="16" r="3"/><path d="M19 13v-1M19 20v-1M22 16h1M16 16h-1" strokeWidth="1.5"/>
      </svg>
    ),
    title: 'Metadata Migration',
    subtitle: 'Manage Salesforce code extraction, AI conversion, and D365 deployment per org',
    steps: [
      { num: '＋', label: 'Connect Org', desc: 'Store Salesforce credentials (username, password, security token, consumer key/secret) and D365 credentials (tenant, client ID/secret, org URL) together as a named "Org" connection in SQLite.' },
      { num: '⇣', label: 'Extract', desc: 'Choose metadata types (Apex Classes, Apex Triggers, Flows, LWC, Aura Components) and pull them from Salesforce into the local database. Extraction status is tracked per org with timestamps.' },
      { num: '⊗', label: 'Vector Index', desc: 'Embed extracted metadata into a Qdrant vector store. Enables semantic search — the AI Agent Chat can find "similar logic to X" or "all triggers on Account" across your entire codebase.' },
      { num: '💬', label: 'Agent Chat', desc: 'Ask natural-language questions about your Salesforce org: "What does AccountTrigger do?", "List all flows that update Opportunity stage", "Are there any Apex classes that call external APIs?" — powered by RAG.' },
      { num: '⇄', label: 'Code Converter', desc: 'Navigate to the full Code Converter experience for this org — select individual components, convert, validate, save, and deploy one at a time.' },
      { num: '📋', label: 'Deployment Plan', desc: 'Open the Deployment Plan for this org — bulk-convert and deploy multiple components in a managed, sequenced migration run.' },
    ],
  },
  {
    color: '#f59e0b',
    iconSvg: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2a4 4 0 0 1 4 4c0 1.5-.8 2.8-2 3.5V11h-4V9.5A4 4 0 0 1 8 6a4 4 0 0 1 4-4z"/><rect x="8" y="11" width="8" height="5" rx="1"/><path d="M9 16v2M12 16v3M15 16v2"/><path d="M6 8H4a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2M18 8h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-2"/>
      </svg>
    ),
    title: 'LLM Connector',
    subtitle: 'Configure the AI model that powers code conversion and Agent Chat',
    steps: [
      { num: '🔑', label: 'Add a Provider', desc: 'Click "+ Add LLM". Choose provider: OpenAI (GPT-4o, GPT-4o-mini, GPT-4-turbo), Anthropic (Claude Sonnet, Haiku, Opus), or Cohere (Command R+, Command R). Enter your API key.' },
      { num: '★', label: 'Set as Default', desc: 'Mark one connection as Default. This model is used automatically for all Code Conversion, Agent Chat, and Validation calls across the entire app.' },
      { num: '🔒', label: 'Encryption', desc: 'API keys are encrypted at rest using AES-256 before being written to SQLite. They are never logged, never sent to any third party, and can be deleted at any time.' },
      { num: '🧪', label: 'Test Connection', desc: 'Each LLM connector has a Test button that sends a lightweight ping to verify the API key is valid and the model is reachable before it is used for actual conversions.' },
    ],
  },
  {
    color: '#06b6d4',
    iconSvg: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="5" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><circle cx="12" cy="12" r="2.5"/><path d="M7 5h10M5 7v10M7 19h10M19 7v10M7 7l4 4M17 7l-4 4M7 17l4-4M17 17l-4-4" strokeWidth="1.4" strokeOpacity="0.7"/>
      </svg>
    ),
    title: 'Vector Connector',
    subtitle: 'Configure the vector database for semantic search and Agent Chat RAG',
    steps: [
      { num: '⬡', label: 'Qdrant (Recommended)', desc: 'Add a Qdrant connection. Leave the URL blank for local file storage — no Docker, no server needed for development. Provide a Qdrant Cloud URL + API key for production.' },
      { num: '📌', label: 'Pinecone', desc: 'Add a Pinecone connection with your index URL (e.g. https://my-index-xyz.svc.pinecone.io) and API key from the Pinecone console.' },
      { num: '★', label: 'Default Config', desc: 'One vector config is marked as Default. It is used automatically when indexing Salesforce metadata from the Metadata Migration page and when Agent Chat performs semantic search.' },
      { num: '🧪', label: 'Test Connection', desc: 'The Test button pings the vector database to verify connectivity and confirms the collection/index is accessible before indexing begins.' },
    ],
  },
  {
    color: '#10b981',
    iconSvg: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/>
      </svg>
    ),
    title: 'LLM Usage',
    subtitle: 'Full audit log of every AI/LLM call — tokens, cost, duration, status',
    steps: [
      { num: '📈', label: 'Summary Tiles', desc: 'Top row shows aggregated totals: Total Calls, Input Tokens, Output Tokens, Total Tokens, and Estimated Cost (USD) — filtered by the selected call type.' },
      { num: '🔍', label: 'Filter by Type', desc: 'Filter pills: All · Code Convert (conversions) · Agent Chat (RAG responses) · Indexing (embedding calls) · Sense (analytics calls). Tiles and table update instantly.' },
      { num: '📋', label: 'History Table', desc: 'Each row shows: timestamp, call type, model name, org, component name, input tokens, output tokens, cost, duration (ms), and a success/error status dot.' },
      { num: '💰', label: 'Cost Tracking', desc: 'Costs are calculated using published per-token pricing for each model. Use this to audit spend, detect unexpectedly expensive calls, and choose the most cost-effective model for your workflow.' },
    ],
  },
  {
    color: '#ef4444',
    iconSvg: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
      </svg>
    ),
    title: 'Deployment Logs',
    subtitle: 'Complete audit trail of every D365 deployment with downloadable build logs',
    steps: [
      { num: '🏷', label: 'Summary Tiles', desc: 'Always-visible tiles show total deployments, succeeded count, manual count, and failed count for the selected org — unaffected by the status filter.' },
      { num: '🔍', label: 'Status Filter', desc: 'Filter pills: All · Success · Manual · Failed · Running. When a filter has no matches, the tiles remain visible and the table shows a "no records" message.' },
      { num: '📄', label: 'Log Table Columns', desc: 'Time · Component Name · Type (apex_class, flow, lwc…) · Source (Code Converter / Deploy Plan) · Steps (number of deploy sub-steps) · Assembly/Resource ID · Status · Download.' },
      { num: '⬇', label: 'Download Log', desc: 'Click the download button on any row to save the full build output and D365 plugin registration result as a .log file. The log includes compilation output, error messages, and the returned assembly ID.' },
      { num: '🔴', label: 'Error Details', desc: 'Failed rows show the beginning of the error message directly in the Assembly/Resource ID column. Hover for the full text, or download the log for the complete stack trace.' },
    ],
  },
  {
    color: '#f97316',
    iconSvg: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/><path d="M12 2v20" strokeWidth="1.4" strokeOpacity="0.5"/>
      </svg>
    ),
    title: 'Code Converter',
    subtitle: 'AI-powered Salesforce → Dynamics 365 component conversion with one-click deploy',
    steps: [
      { num: '①', label: 'Select Org & Component', desc: 'Choose a connected Salesforce Org from the dropdown, then pick a component type (Apex Class, Trigger, Flow, LWC, Aura) and the specific component name from the extracted metadata.' },
      { num: '②', label: 'SOURCE Panel', desc: 'Displays the original Salesforce source code — Apex for classes/triggers, XML for flows, HTML/JS for LWC. Read-only reference while you work on the conversion.' },
      { num: '③', label: 'Add Notes', desc: 'Use the Notes field to guide the LLM: "Target D365 v9.2 API", "Avoid deprecated IPlugin constructor", "This trigger fires on Account update only". The notes are injected into the conversion prompt.' },
      { num: '④', label: 'Convert & TARGET Panel', desc: 'Click Convert. The AI generates the D365 equivalent in the TARGET panel — C# IPlugin class for Apex, Power Automate-equivalent logic for Flows, PCF component blueprint for LWC.' },
      { num: '⑤', label: 'Validate', desc: 'Runs a second LLM pass over the generated code to catch compilation errors, deprecated API usage, missing using statements, and logical mismatches before deployment.' },
      { num: '⑥', label: 'Save & Deploy', desc: 'Save stores the conversion to SQLite. Deploy compiles the C# code with dotnet CLI, packages it as a plugin assembly, registers it with D365 via the Plugin Registration Tool, and records the assembly ID.' },
      { num: '⑦', label: 'Deployment History', desc: 'The History button in the TARGET panel header shows all past deployment attempts for this specific component — with status, steps, assembly ID, and timestamps.' },
    ],
  },
  {
    color: '#6366f1',
    iconSvg: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
      </svg>
    ),
    title: 'Deployment Plan',
    subtitle: 'Orchestrate bulk migration — convert and deploy multiple components in one run',
    steps: [
      { num: '①', label: 'Create a Plan', desc: 'A Deployment Plan groups multiple converted components into a single migration run. Created automatically when you navigate from the Metadata Migration page for a specific org.' },
      { num: '②', label: 'Plan Items', desc: 'Each item in the plan shows: Salesforce source type, component name, converted D365 type, current status (pending / converted / deployed / failed), and last update time.' },
      { num: '③', label: 'Convert All', desc: 'Triggers AI conversion for all pending items in the plan sequentially. Each item\'s status updates in real-time as the LLM processes it.' },
      { num: '④', label: 'Run All', desc: 'Deploys every converted-but-not-yet-deployed component in sequence — compile, register, confirm. Items that fail are marked individually; successful items continue.' },
      { num: '⑤', label: 'Per-Item Actions', desc: 'Each plan item has individual Convert, Validate, Deploy, and View Log buttons. Use these to re-run failed items or inspect a specific component\'s deployment result.' },
    ],
  },
];

/* ── App Tour ────────────────────────────────────────────────────────── */
const TOUR_STEPS = [
  {
    target: 'tour-sidebar',
    placement: 'right',
    color: '#23a55e',
    iconSvg: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>
      </svg>
    ),
    title: 'Welcome to SF → D365 Wizard',
    desc: 'This sidebar is your command center. Every feature of the Salesforce to Dynamics 365 migration tool lives here — navigate between pipelines, connectors, usage analytics, and deployment logs.',
  },
  {
    target: 'tour-nav-data',
    placement: 'right',
    color: '#3b82f6',
    iconSvg: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v4c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 9v4c0 1.66 4.03 3 9 3s9-1.34 9-3V9"/><path d="M3 13v4c0 1.66 4.03 3 9 3s9-1.34 9-3v-4"/>
      </svg>
    ),
    title: 'Data Migration',
    desc: 'The classic 5-step data pipeline: Connect your orgs → Select Salesforce objects → Map fields to D365 equivalents → Apply schema → Transfer records. Handles Accounts, Contacts, custom objects, and more.',
  },
  {
    target: 'tour-nav-metadata',
    placement: 'right',
    color: '#8b5cf6',
    iconSvg: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 6h16M4 10h16M4 14h10M4 18h6"/><circle cx="19" cy="16" r="3"/><path d="M19 13v-1M19 20v-1M22 16h1M16 16h-1" strokeWidth="1.5"/>
      </svg>
    ),
    title: 'Metadata Migration',
    desc: 'Manage your connected Salesforce orgs. Extract Apex Classes, Triggers, Flows, LWC, and Aura Components — then use AI to convert each one into Dynamics 365 C# Plugins or Power Automate equivalents.',
  },
  {
    target: 'tour-nav-llm',
    placement: 'right',
    color: '#f59e0b',
    iconSvg: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2a4 4 0 0 1 4 4c0 1.5-.8 2.8-2 3.5V11h-4V9.5A4 4 0 0 1 8 6a4 4 0 0 1 4-4z"/><rect x="8" y="11" width="8" height="5" rx="1"/><path d="M9 16v2M12 16v3M15 16v2"/><path d="M6 8H4a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2M18 8h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-2"/>
      </svg>
    ),
    title: 'LLM Connector',
    desc: 'Wire up your AI provider here. Supports OpenAI (GPT-4o, GPT-4o-mini), Anthropic (Claude Sonnet, Haiku, Opus), and Cohere (Command R+). Mark one as Default — it powers all code conversions and Agent Chat.',
  },
  {
    target: 'tour-nav-vector',
    placement: 'right',
    color: '#06b6d4',
    iconSvg: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="5" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><circle cx="12" cy="12" r="2.5"/><path d="M7 5h10M5 7v10M7 19h10M19 7v10M7 7l4 4M17 7l-4 4M7 17l4-4M17 17l-4-4" strokeWidth="1.4"/>
      </svg>
    ),
    title: 'Vector Connector',
    desc: 'Configure your vector database for semantic search. Qdrant runs locally with zero setup — just leave the URL blank. Provide a Qdrant Cloud URL or Pinecone credentials for production-grade RAG.',
  },
  {
    target: 'tour-nav-llm-usage',
    placement: 'right',
    color: '#10b981',
    iconSvg: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/>
      </svg>
    ),
    title: 'LLM Usage Tracker',
    desc: 'Every AI call is logged here — input tokens, output tokens, estimated USD cost, latency in ms, and success/error status. Filter by call type (Convert, Agent Chat, Indexing) to audit spend.',
  },
  {
    target: 'tour-nav-deploy-logs',
    placement: 'right',
    color: '#ef4444',
    iconSvg: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
      </svg>
    ),
    title: 'Deployment Logs',
    desc: 'A complete audit trail of every D365 deployment attempt. Filter by Success / Failed / Running. Download the full build output and plugin registration log for any deployment with one click.',
  },
  {
    target: 'tour-guide-btn',
    placement: 'right',
    color: '#23a55e',
    iconSvg: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
    ),
    title: 'App Guide',
    desc: 'Open the in-app guide for detailed walkthroughs. Each section covers a specific feature with step-by-step instructions — everything from connecting your first org to bulk-deploying a migration plan.',
  },
  {
    target: 'tour-theme-toggle',
    placement: 'right',
    color: '#a78bfa',
    iconSvg: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
      </svg>
    ),
    title: 'Theme Toggle',
    desc: 'Switch between Dark Mode and Light Mode at any time. Your preference is persisted in localStorage and restored on every visit — the sidebar always stays dark for readability.',
  },
  {
    target: 'tour-topbar',
    placement: 'bottom',
    color: '#23a55e',
    iconSvg: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    ),
    title: 'Status Bar',
    desc: 'Shows the current page name and live system status. A green dot means idle and ready. An amber dot and "Migration Running…" message means a data transfer is in progress — some navigation is locked during this time.',
  },
];

function AppTour({ open, onClose }) {
  const [step, setStep]   = React.useState(0);
  const [rect, setRect]   = React.useState(null);
  const TOOLTIP_W = 340;

  const current = TOUR_STEPS[step];

  React.useEffect(() => {
    if (!open) { setStep(0); return; }
    const el = document.querySelector(`[data-tour="${current.target}"]`);
    if (!el) { setRect(null); return; }
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
  }, [open, step, current]);

  if (!open) return null;

  const PAD = 8;
  const spotStyle = rect
    ? { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }
    : { top: '45%', left: '45%', width: 80, height: 80 };

  const getTooltipStyle = () => {
    if (!rect) return { top: '50%', left: '50%', transform: 'translate(-50%,-50%)' };
    const { placement } = current;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 18;

    if (placement === 'right') {
      const left = rect.left + rect.width + margin;
      const top  = Math.min(vh - 320, Math.max(10, rect.top + rect.height / 2 - 140));
      return left + TOOLTIP_W > vw
        ? { top, left: rect.left - TOOLTIP_W - margin }
        : { top, left };
    }
    if (placement === 'bottom') {
      const top  = rect.top + rect.height + margin;
      const left = Math.min(vw - TOOLTIP_W - 10, Math.max(10, rect.left + rect.width / 2 - TOOLTIP_W / 2));
      return { top, left };
    }
    if (placement === 'top') {
      const left = Math.min(vw - TOOLTIP_W - 10, Math.max(10, rect.left + rect.width / 2 - TOOLTIP_W / 2));
      return { top: rect.top - 260 - margin, left };
    }
    return { top: 80, left: 80 };
  };

  const isLast  = step === TOUR_STEPS.length - 1;
  const c       = current.color;

  return (
    <>
      {/* Spotlight overlay via box-shadow on a transparent div */}
      <div className="tour-spotlight" style={spotStyle} />

      {/* Tooltip card */}
      <div className="tour-tooltip" style={{ ...getTooltipStyle(), '--tour-color': c, width: TOOLTIP_W }}>
        {/* Header */}
        <div className="tour-tooltip-head" style={{ borderBottom: `2px solid ${c}22` }}>
          <span className="tour-tooltip-icon" style={{ background: c + '22', color: c, border: `1.5px solid ${c}44` }}>{current.iconSvg}</span>
          <span className="tour-step-counter" style={{ color: c }}>{step + 1} <span style={{ color: '#4b5563' }}>/ {TOUR_STEPS.length}</span></span>
        </div>

        {/* Body */}
        <div className="tour-tooltip-body">
          <h3 className="tour-tooltip-title">{current.title}</h3>
          <p className="tour-tooltip-desc">{current.desc}</p>
        </div>

        {/* Progress dots */}
        <div className="tour-dots">
          {TOUR_STEPS.map((_, i) => (
            <button
              key={i}
              className={`tour-dot${i === step ? ' active' : ''}`}
              style={i === step ? { background: c, borderColor: c } : {}}
              onClick={() => setStep(i)}
              title={TOUR_STEPS[i].title}
            />
          ))}
        </div>

        {/* Actions */}
        <div className="tour-actions">
          <button className="tour-skip" onClick={onClose}>Skip tour</button>
          <div className="tour-nav">
            {step > 0 && (
              <button className="tour-prev" onClick={() => setStep(s => s - 1)}>‹ Prev</button>
            )}
            {!isLast ? (
              <button className="tour-next" style={{ background: c }} onClick={() => setStep(s => s + 1)}>
                Next ›
              </button>
            ) : (
              <button className="tour-finish" style={{ background: c }} onClick={onClose}>
                ✓ Finish
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function GuidePanel({ open, onClose }) {
  const [activeIdx, setActiveIdx] = React.useState(0);
  if (!open) return null;
  const sec = GUIDE_SECTIONS[activeIdx];
  return (
    <>
      <div className="guide-backdrop" onClick={onClose} />
      <div className="guide-panel">
        {/* Header */}
        <div className="guide-panel-header">
          <div className="guide-panel-header-left">
            <span className="guide-panel-logo">📖</span>
            <div>
              <div className="guide-panel-title">App Guide</div>
              <div className="guide-panel-tagline">SF → Dynamics 365 Migration Wizard</div>
            </div>
          </div>
          <button className="guide-panel-close" onClick={onClose} title="Close">✕</button>
        </div>

        <div className="guide-panel-body">
          {/* Left nav */}
          <div className="guide-nav">
            <div className="guide-nav-heading">Sections</div>
            {GUIDE_SECTIONS.map((s, i) => (
              <button
                key={i}
                className={`guide-nav-item${activeIdx === i ? ' active' : ''}`}
                style={activeIdx === i ? { '--guide-color': s.color } : {}}
                onClick={() => setActiveIdx(i)}
              >
                <span className="guide-nav-icon" style={{ color: activeIdx === i ? s.color : undefined }}>
                  {s.iconSvg}
                </span>
                <span className="guide-nav-label">{s.title}</span>
                {activeIdx === i && <span className="guide-nav-arrow">›</span>}
              </button>
            ))}
          </div>

          {/* Right content */}
          <div className="guide-content">
            {/* Content hero */}
            <div className="guide-content-hero" style={{ '--guide-color': sec.color }}>
              <div className="guide-content-hero-icon" style={{ color: sec.color, background: sec.color + '18', borderColor: sec.color + '35' }}>
                {sec.iconSvg}
              </div>
              <div>
                <h2 className="guide-content-title">{sec.title}</h2>
                <p className="guide-content-subtitle">{sec.subtitle}</p>
              </div>
            </div>

            {/* Steps */}
            <div className="guide-steps">
              {sec.steps.map((step, i) => (
                <div key={i} className="guide-step">
                  <div className="guide-step-num" style={{ background: sec.color + '18', color: sec.color, borderColor: sec.color + '40' }}>
                    {step.num}
                  </div>
                  <div className="guide-step-body">
                    <div className="guide-step-label">{step.label}</div>
                    <div className="guide-step-desc">{step.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function App() {
  // ── Auth state ────────────────────────────────────────────────────────────
  const [authUser,  setAuthUser]  = useState(() => {
    try { return JSON.parse(localStorage.getItem('sf2d_user') || 'null'); } catch { return null; }
  });
  const [authToken, setAuthToken] = useState(() => localStorage.getItem('sf2d_token') || null);

  const handleLogin = (user, token) => {
    setAuthUser(user);
    setAuthToken(token);
  };

  const handleLogout = () => {
    localStorage.removeItem('sf2d_token');
    localStorage.removeItem('sf2d_user');
    setAuthUser(null);
    setAuthToken(null);
  };

  const [activeMainTab, setActiveMainTab] = useState(() => {
    const saved = readStorage(STORAGE_KEYS.mainTab, 'data');
    // Safety: only restore converter/deployment if their orgId was also persisted
    if (saved === 'converter'  && !readStorage(STORAGE_KEYS.converterOrgId,  null)) return 'metadata';
    if (saved === 'deployment' && !readStorage(STORAGE_KEYS.deploymentOrgId, null)) return 'metadata';
    return saved;
  });
  const [currentTab, setCurrentTab] = useState(
    () => readStorage(STORAGE_KEYS.tab, 'connection')
  );
  const [selectedObjects, setSelectedObjects] = useState(
    () => readStorage(STORAGE_KEYS.objects, [])
  );
  const [migrationRunning, setMigrationRunning] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => readStorage(STORAGE_KEYS.collapsed, false)
  );

  const [converterOrgId,      setConverterOrgId]      = useState(() => readStorage(STORAGE_KEYS.converterOrgId,      null));
  const [deploymentOrgId,     setDeploymentOrgId]     = useState(() => readStorage(STORAGE_KEYS.deploymentOrgId,     null));
  const [deploymentOrgName,   setDeploymentOrgName]   = useState(() => readStorage(STORAGE_KEYS.deploymentOrgName,   ''));
  const [metadataDetailOrgId, setMetadataDetailOrgId] = useState(() => readStorage(STORAGE_KEYS.metadataDetailOrgId, null));

  const [showGuide, setShowGuide] = useState(false);
  const [showTour,  setShowTour]  = useState(false);

  const [theme, setTheme] = useState(() => {
    const saved = readStorage(STORAGE_KEYS.theme, null);
    if (saved) return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  const [confirmed, setConfirmed] = useState(
    () => readStorage(STORAGE_KEYS.confirmed, {
      connection: false,
      objects: false,
      mapping: false,
      schema_migration: false,
      data_migration: false,
    })
  );

  // Persist all navigation state so page refresh restores the exact view
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.mainTab,             JSON.stringify(activeMainTab));      } catch { /* ignore */ }
  }, [activeMainTab]);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.tab,                 JSON.stringify(currentTab));         } catch { /* ignore */ }
  }, [currentTab]);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.confirmed,           JSON.stringify(confirmed));          } catch { /* ignore */ }
  }, [confirmed]);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.objects,             JSON.stringify(selectedObjects));    } catch { /* ignore */ }
  }, [selectedObjects]);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.collapsed,           JSON.stringify(sidebarCollapsed));   } catch { /* ignore */ }
  }, [sidebarCollapsed]);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.converterOrgId,      JSON.stringify(converterOrgId));     } catch { /* ignore */ }
  }, [converterOrgId]);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.deploymentOrgId,     JSON.stringify(deploymentOrgId));    } catch { /* ignore */ }
  }, [deploymentOrgId]);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.deploymentOrgName,   JSON.stringify(deploymentOrgName));  } catch { /* ignore */ }
  }, [deploymentOrgName]);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.metadataDetailOrgId, JSON.stringify(metadataDetailOrgId));} catch { /* ignore */ }
  }, [metadataDetailOrgId]);
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(STORAGE_KEYS.theme, JSON.stringify(theme)); } catch { /* ignore */ }
  }, [theme]);

  const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark');

  const confirmStep = useCallback((stepId) => {
    setConfirmed((p) => ({ ...p, [stepId]: true }));
  }, []);

  const unconfirmStep = useCallback((stepId) => {
    setConfirmed((p) => ({ ...p, [stepId]: false }));
  }, []);

  // Show login page if not authenticated (must come after all hooks)
  if (!authUser || !authToken) {
    return <LoginPage onLogin={handleLogin} />;
  }

  const isStepReachable = (stepId) => {
    if (migrationRunning && stepId !== currentTab) return false;
    const idx = DATA_STEPS.findIndex((s) => s.id === stepId);
    for (let i = 0; i < idx; i++) {
      if (!confirmed[DATA_STEPS[i].id]) return false;
    }
    return true;
  };

  const handleStepClick = (id) => {
    if (!isStepReachable(id)) return;
    setCurrentTab(id);
  };

  const handleMainTabClick = (tabId) => {
    if (migrationRunning && activeMainTab !== tabId) return;
    setActiveMainTab(tabId);
    setMobileNavOpen(false);
  };

  const handleNavigateToConverter = (orgId) => {
    setConverterOrgId(orgId || null);
    setMetadataDetailOrgId(orgId || null); // remember which org to return to
    setActiveMainTab('converter');
    setMobileNavOpen(false);
  };

  const handleNavigateToDeployment = (orgId, orgName) => {
    setDeploymentOrgId(orgId || null);
    setDeploymentOrgName(orgName || '');
    setMetadataDetailOrgId(orgId || null); // remember which org to return to
    setActiveMainTab('deployment');
    setMobileNavOpen(false);
  };

  const handleNavigateToAgentChat = () => {
    setActiveMainTab('agent_chat');
    setMobileNavOpen(false);
  };

  const handleBackToMetadata = () => {
    setActiveMainTab('metadata');
  };

  const handleObjectsChange = (objs) => {
    setSelectedObjects(objs);
  };

  const goToNextAfterConfirm = (currentStepId) => {
    const idx = DATA_STEPS.findIndex((s) => s.id === currentStepId);
    if (idx < DATA_STEPS.length - 1) {
      setTimeout(() => setCurrentTab(DATA_STEPS[idx + 1].id), 300);
    }
  };

  const renderStepContent = () => {
    switch (currentTab) {
      case 'connection':
        return (
          <ConnectionTab
            onConfirm={() => { confirmStep('connection'); goToNextAfterConfirm('connection'); }}
            onUnconfirm={() => {
              unconfirmStep('connection');
              unconfirmStep('objects');
              unconfirmStep('mapping');
              unconfirmStep('schema_migration');
              unconfirmStep('data_migration');
            }}
            isConfirmed={confirmed.connection}
          />
        );
      case 'objects':
        return (
          <ObjectsTab
            onSelectionChange={handleObjectsChange}
            onConfirm={() => { confirmStep('objects'); goToNextAfterConfirm('objects'); }}
            onUnconfirm={() => { unconfirmStep('objects'); unconfirmStep('mapping'); unconfirmStep('schema_migration'); unconfirmStep('data_migration'); }}
            isConfirmed={confirmed.objects}
          />
        );
      case 'mapping':
        return (
          <MappingTab
            selectedObjects={selectedObjects}
            onConfirm={() => { confirmStep('mapping'); goToNextAfterConfirm('mapping'); }}
            onUnconfirm={() => { unconfirmStep('mapping'); unconfirmStep('schema_migration'); unconfirmStep('data_migration'); }}
            isConfirmed={confirmed.mapping}
          />
        );
      case 'schema_migration':
        return (
          <MigrationTab
            pipelineType="schema"
            title="Schema Pipeline"
            selectedObjects={selectedObjects}
            onMigrationStateChange={setMigrationRunning}
            onConfirm={() => { confirmStep('schema_migration'); goToNextAfterConfirm('schema_migration'); }}
            isConfirmed={confirmed.schema_migration}
          />
        );
      case 'data_migration':
        return (
          <MigrationTab
            pipelineType="data"
            title="Data Migration Pipeline"
            selectedObjects={selectedObjects}
            onMigrationStateChange={setMigrationRunning}
          />
        );
      default: return null;
    }
  };

  return (
    <div className={`app-shell${sidebarCollapsed ? ' sidebar-is-collapsed' : ''}`}>
      {/* ── Mobile Header ── */}
      <div className="mobile-header">
        <button className="mobile-menu-btn" onClick={() => setMobileNavOpen(!mobileNavOpen)}>
          {mobileNavOpen ? '✕' : '☰'}
        </button>
        <span className="mobile-header-title">
          {activeMainTab === 'data'         ? 'Data Migration'
            : activeMainTab === 'metadata'    ? 'Metadata Migration'
            : activeMainTab === 'llm'         ? 'LLM Connector'
            : activeMainTab === 'converter'   ? 'Code Converter'
            : activeMainTab === 'llm_usage'   ? 'LLM Usage'
            : activeMainTab === 'deploy_logs' ? 'Deployment Logs'
            : activeMainTab === 'vector'      ? 'Vector Connector'
            : activeMainTab === 'agent_chat'  ? 'Agent Chat'
            : activeMainTab === 'deployment'  ? 'Deployment Plans'
            : activeMainTab === 'admin'       ? 'User Management'
            : 'SF → Dynamics Migration'}
        </span>
      </div>

      {/* ── Sidebar — only main tabs ── */}
      <aside className={`sidebar${sidebarCollapsed ? ' collapsed' : ''}${mobileNavOpen ? ' sidebar-open' : ''}`} data-tour="tour-sidebar">
        <div className="sidebar-top-row">
          <div className="sidebar-logo">
            {!sidebarCollapsed ? (
              <>
                <img
                  src="/gruve-logo.svg"
                  alt="Gruve"
                  className="sidebar-logo-img"
                />
                <span className="sidebar-logo-sub">SF → Dynamics Migration</span>
              </>
            ) : (
              <div className="sidebar-logo-icon-sm">G</div>
            )}
          </div>
          <button
            className="sidebar-collapse-btn"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? '»' : '«'}
          </button>
        </div>

        <ul className="nav-list">
          {!sidebarCollapsed && <li className="nav-section-label">Migration</li>}
          <li
            className={`nav-item main-nav-item${activeMainTab === 'data' ? ' active' : ''}${migrationRunning && activeMainTab !== 'data' ? ' disabled' : ''}`}
            onClick={() => handleMainTabClick('data')}
            title={migrationRunning && activeMainTab !== 'data' ? 'Migration in progress' : 'Data Migration'}
            data-tour="tour-nav-data"
          >
            <span className="nav-icon"><IconDataMigration /></span>
            {!sidebarCollapsed && 'Data Migration'}
          </li>
          <li
            className={`nav-item main-nav-item${activeMainTab === 'metadata' ? ' active' : ''}${migrationRunning && activeMainTab !== 'metadata' ? ' disabled' : ''}`}
            onClick={() => handleMainTabClick('metadata')}
            title={migrationRunning && activeMainTab !== 'metadata' ? 'Migration in progress' : 'Metadata Migration'}
            data-tour="tour-nav-metadata"
          >
            <span className="nav-icon"><IconMetadata /></span>
            {!sidebarCollapsed && 'Metadata Migration'}
          </li>

          {sidebarCollapsed ? <li className="nav-divider" /> : <li className="nav-section-label">Connectors</li>}

          <li
            className={`nav-item main-nav-item${activeMainTab === 'llm' ? ' active' : ''}`}
            onClick={() => handleMainTabClick('llm')}
            title="LLM Connector"
            data-tour="tour-nav-llm"
          >
            <span className="nav-icon"><IconLLM /></span>
            {!sidebarCollapsed && 'LLM Connector'}
          </li>
          <li
            className={`nav-item main-nav-item${activeMainTab === 'vector' ? ' active' : ''}`}
            onClick={() => handleMainTabClick('vector')}
            title="Vector Connector"
            data-tour="tour-nav-vector"
          >
            <span className="nav-icon"><IconVector /></span>
            {!sidebarCollapsed && 'Vector Connector'}
          </li>

          {sidebarCollapsed ? <li className="nav-divider" /> : <li className="nav-section-label">Analytics</li>}

          <li
            className={`nav-item main-nav-item${activeMainTab === 'llm_usage' ? ' active' : ''}`}
            onClick={() => handleMainTabClick('llm_usage')}
            title="LLM Usage"
            data-tour="tour-nav-llm-usage"
          >
            <span className="nav-icon"><IconLLMUsage /></span>
            {!sidebarCollapsed && 'LLM Usage'}
          </li>
          <li
            className={`nav-item main-nav-item${activeMainTab === 'deploy_logs' ? ' active' : ''}`}
            onClick={() => handleMainTabClick('deploy_logs')}
            title="Deployment Logs"
            data-tour="tour-nav-deploy-logs"
          >
            <span className="nav-icon"><IconDeployLogs /></span>
            {!sidebarCollapsed && 'Deployment Logs'}
          </li>

          {/* Admin section in nav */}
          {authUser?.role === 'admin' && (<>
            {sidebarCollapsed ? <li className="nav-divider" /> : <li className="nav-section-label">Admin</li>}
            <li
              className={`nav-item main-nav-item${activeMainTab === 'admin' ? ' active nav-item--admin-active' : ' nav-item--admin'}`}
              onClick={() => setActiveMainTab('admin')}
              title="User Management"
            >
              <span className="nav-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                  <circle cx="9" cy="7" r="4"/>
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                  <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                </svg>
              </span>
              {!sidebarCollapsed && 'User Management'}
            </li>
          </>)}
        </ul>

        <div className="sidebar-bottom">
          {/* Utility strip: Guide | Tour | Theme */}
          <div className="sidebar-utils">
            <button className="sidebar-util-btn" onClick={() => setShowGuide(true)} title="App Guide" data-tour="tour-guide-btn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>
              </svg>
              {!sidebarCollapsed && <span>Guide</span>}
            </button>
            <button className="sidebar-util-btn sidebar-util-btn--tour" onClick={() => setShowTour(true)} title="App Tour">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
              {!sidebarCollapsed && <span>Tour</span>}
            </button>
            <button className="sidebar-util-btn sidebar-util-btn--theme" onClick={toggleTheme} title={theme === 'dark' ? 'Light Mode' : 'Dark Mode'} data-tour="tour-theme-toggle">
              {theme === 'dark'
                ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
                : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
              }
              {!sidebarCollapsed && <span>{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>}
            </button>
          </div>

          {migrationRunning && !sidebarCollapsed && (
            <div className="sidebar-migration-warning">
              ⚠️ Migration running — navigation locked
            </div>
          )}

          {/* User card */}
          {authUser && (
            <div className="sidebar-user-card">
              <div className="sidebar-user-avatar">{authUser.name?.[0]?.toUpperCase() || '?'}</div>
              {!sidebarCollapsed && (
                <div className="sidebar-user-info">
                  <div className="sidebar-user-name">{authUser.name}</div>
                  <div className="sidebar-user-email">{authUser.email}</div>
                </div>
              )}
              <button className="sidebar-logout-btn" onClick={handleLogout} title="Sign out">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                  <polyline points="16 17 21 12 16 7"/>
                  <line x1="21" y1="12" x2="9" y2="12"/>
                </svg>
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* ── App Guide Panel ── */}
      <GuidePanel open={showGuide} onClose={() => setShowGuide(false)} />

      {/* ── App Tour ── */}
      <AppTour open={showTour} onClose={() => setShowTour(false)} />

      {/* ── Mobile Overlay ── */}
      {mobileNavOpen && <div className="sidebar-overlay" onClick={() => setMobileNavOpen(false)} />}

      {/* ── Main Content ── */}
      <main className="main-content">
        {/* ── Topbar ── */}
        <div className="topbar" data-tour="tour-topbar">
          <span className="topbar-title">
            {activeMainTab === 'data'         ? 'Data Migration'
              : activeMainTab === 'metadata'   ? 'Metadata Migration'
              : activeMainTab === 'llm'         ? 'LLM Connector'
              : activeMainTab === 'converter'   ? 'Code Converter'
              : activeMainTab === 'llm_usage'   ? 'LLM Usage'
              : activeMainTab === 'deploy_logs' ? 'Deployment Logs'
              : activeMainTab === 'vector'      ? 'Vector Connector'
              : activeMainTab === 'agent_chat'  ? 'Agent Chat'
              : activeMainTab === 'deployment'  ? 'Deployment Plans'
              : activeMainTab === 'admin'       ? 'User Management'
              : 'SF → Dynamics Migration'}
          </span>
          <span className="topbar-subtitle">
            <span className="status-dot" style={{ background: migrationRunning ? 'var(--warning)' : undefined }} />
            {migrationRunning ? 'Migration Running…' : 'Ready'}
          </span>
        </div>

        {/* ── Page Content ── */}
        <div className="page-inner">
          {activeMainTab === 'admin' ? (
            <AdminUsersPage currentUser={authUser} />
          ) : activeMainTab === 'agent_chat' ? (
            <AgentChatPage onBack={() => setActiveMainTab('metadata')} />
          ) : activeMainTab === 'llm' ? (
            <LLMConnectorPage />
          ) : activeMainTab === 'vector' ? (
            <VectorConnectorPage />
          ) : activeMainTab === 'converter' ? (
            <CodeConverterPage initialOrgId={converterOrgId} onBack={handleBackToMetadata} onGoToMetadata={handleBackToMetadata} />
          ) : activeMainTab === 'llm_usage' ? (
            <LLMUsagePage currentUser={authUser} />
          ) : activeMainTab === 'deploy_logs' ? (
            <DeployLogsPage currentUser={authUser} />
          ) : activeMainTab === 'deployment' ? (
            <DeploymentPlanPage
              orgId={deploymentOrgId}
              orgName={deploymentOrgName}
              onBack={handleBackToMetadata}
            />
          ) : activeMainTab === 'metadata' ? (
            <ShiftTab
              onNavigateToConverter={handleNavigateToConverter}
              onNavigateToDeployment={handleNavigateToDeployment}
              onNavigateToAgentChat={handleNavigateToAgentChat}
              initialDetailOrgId={metadataDetailOrgId}
              onDetailOrgChange={setMetadataDetailOrgId}
            />
          ) : (
            <>
              {/* ── Inner Step Tabs ── */}
              <div className="inner-tabs">
                {DATA_STEPS.map((step) => {
                  const reachable = isStepReachable(step.id);
                  const active = currentTab === step.id;
                  const done = confirmed[step.id];
                  const locked = migrationRunning && step.id !== currentTab;
                  return (
                    <button
                      key={step.id}
                      className={`inner-tab${active ? ' active' : ''}${!reachable ? ' disabled' : ''}${done ? ' done' : ''}${locked ? ' locked' : ''}`}
                      onClick={() => handleStepClick(step.id)}
                      disabled={!reachable || locked}
                      title={
                        locked ? 'Migration in progress' :
                          !reachable ? 'Complete previous steps first' :
                            step.label
                      }
                    >
                      <span className="inner-tab-num">{done ? '✓' : step.step}</span>
                      <span className="inner-tab-icon">{step.icon}</span>
                      <span className="inner-tab-label">{step.label}</span>
                    </button>
                  );
                })}
              </div>

              {/* ── Step Content ── */}
              <div className="step-content">
                {renderStepContent()}
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;