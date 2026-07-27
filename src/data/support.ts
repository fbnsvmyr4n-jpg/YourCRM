export type Faq = {
  q: string;
  a: string;
  category: FaqCategory;
};

export const FAQ_CATEGORIES = [
  "Getting started",
  "Pipeline & deals",
  "Agents",
  "Contacts & leads",
  "Account",
] as const;

export type FaqCategory = (typeof FAQ_CATEGORIES)[number];

export const faqs: Faq[] = [
  /* ---- Getting started ---- */
  {
    category: "Getting started",
    q: "How do I find anything quickly?",
    a: "Press ⌘K (Ctrl+K on Windows) anywhere in YourCRM to open the command palette. It searches across your contacts, deals, leads, meetings and messages at the same time, and also jumps you to any page. Use the arrow keys to move through results and Enter to open one.",
  },
  {
    category: "Getting started",
    q: "Does the app change appearance during the day?",
    a: "Yes. YourCRM ships with automatic time-of-day theming: Day from 06:00, Evening from 18:00, and Night from 21:00. You can override it at any time from the theme control in the top bar or under Settings → Appearance.",
  },
  {
    category: "Getting started",
    q: "Where does my data live?",
    a: "Everything you create — contacts, leads, deals, meetings, messages — is saved to your CRM and persists between sessions. Records you add or edit are stored immediately; there's no separate save step beyond confirming a form.",
  },

  /* ---- Pipeline & deals ---- */
  {
    category: "Pipeline & deals",
    q: "How do I move a deal through the pipeline?",
    a: "Open Deals and drag any card into another stage column — Lead In, Qualified, Proposal, Negotiation, or Closed Won. The move saves automatically, and the column totals plus the summary tiles at the top recalculate instantly.",
  },
  {
    category: "Pipeline & deals",
    q: "What is the Weighted Forecast?",
    a: "It's your pipeline adjusted for likelihood. Each stage carries a win probability — Lead In 10%, Qualified 30%, Proposal 50%, Negotiation 70%, Closed Won 100% — and the forecast is the sum of every deal's value times its stage probability. Move a deal forward and the forecast rises straight away.",
  },
  {
    category: "Pipeline & deals",
    q: "How do I add a deal?",
    a: "Use the Add Deal button in the header of the Deals page, or the “+ Add deal” button at the bottom of any stage column — the latter pre-selects that stage for you. Give it a title, contact, company and value.",
  },
  {
    category: "Pipeline & deals",
    q: "Where do the numbers on Reports come from?",
    a: "Reports is computed live from your actual records — there's nothing to refresh. Open Pipeline, Revenue Won, Win Rate and Avg Deal Size all derive from your deals, and the donut charts break down your real lead sources and contact types. One caveat: revenue figures attached to individual deals are illustrative until revenue tracking is added.",
  },

  /* ---- Agents ---- */
  {
    category: "Agents",
    q: "What does the Voice Agent actually do?",
    a: "Aria handles inbound calls and turns them into CRM records for you. When a call is processed, the caller is captured as a Lead (marked source “Phone Call”), and if they asked for a slot, a Meeting is booked — both appear in your Leads and Meetings tabs without any manual entry. Each call keeps its summary, transcript, and links to whatever it created.",
  },
  {
    category: "Agents",
    q: "How do I try the Voice Agent without a real phone call?",
    a: "Press “Simulate incoming call” on the Voice Agent page. It runs a realistic call through the exact same automation a live call would use, so you can watch a lead and a meeting appear end to end. Connecting a real phone number requires a telephony provider such as Twilio.",
  },
  {
    category: "Agents",
    q: "What can the Chat Agent answer?",
    a: "It can see your live pipeline, contacts, leads, meetings and inbox, so ask it things like “what's my pipeline worth?”, “who should I follow up with?”, “what's on today?”, or “give me a summary”. Answers are drawn from your real records rather than generic advice.",
  },
  {
    category: "Agents",
    q: "What's the difference between AI CONNECTED and DATA MODE?",
    a: "DATA MODE is the built-in assistant — it answers real questions about your CRM data with no setup and no cost. AI CONNECTED appears once an ANTHROPIC_API_KEY is configured, which upgrades the same screen to a full conversational AI that reasons over that same live data and can handle open-ended questions.",
  },

  /* ---- Contacts & leads ---- */
  {
    category: "Contacts & leads",
    q: "What's the difference between a contact and a lead?",
    a: "Contacts are your full address book — each one is marked either Client or Lead. The Leads page is the working pipeline view for people you're actively pursuing, with their status, source and follow-up state. Someone can appear in both as they progress.",
  },
  {
    category: "Contacts & leads",
    q: "How do I add or edit a contact?",
    a: "On Contacts, use the + button beside the contacts list to add someone. To change an existing contact, select them and use the pencil icon above their profile — the form opens pre-filled. The trash icon deletes, and asks you to confirm first.",
  },
  {
    category: "Contacts & leads",
    q: "Can I delete a message by mistake and recover it?",
    a: "Yes. Deleting a message in the Inbox moves it to Trash rather than removing it. Open the Trash filter, select the message, and press Restore to bring it back.",
  },

  /* ---- Account ---- */
  {
    category: "Account",
    q: "How do I change my name, email or password?",
    a: "Go to Settings. The Profile section updates your name and email — your name updates across the app immediately. The Password section requires your current password before setting a new one, which must be at least 8 characters.",
  },
  {
    category: "Account",
    q: "Is my password stored securely?",
    a: "Passwords are never stored in plain text. Each one is hashed with a per-user random salt using scrypt, and comparisons are done in constant time. Your session is held in a signed, httpOnly cookie, which means scripts running in the browser cannot read it.",
  },
  {
    category: "Account",
    q: "How do I sign out?",
    a: "Use Sign out in Settings → Session, or open the user card at the bottom of the sidebar. Signing out clears your session, and protected pages will send you back to the login screen until you sign in again.",
  },
];

export const shortcuts = [
  { keys: ["⌘", "K"], label: "Open command palette / search" },
  { keys: ["↑", "↓"], label: "Move through search results" },
  { keys: ["↵"], label: "Open the highlighted result" },
  { keys: ["Esc"], label: "Close the palette or a dialog" },
];
