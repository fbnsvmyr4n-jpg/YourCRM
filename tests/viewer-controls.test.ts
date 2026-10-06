/*
   A view-only reader is not offered work the product will refuse.

   `permissions.ts` names the exact shape to avoid: "a button that is visible,
   submits, and is refused". The database is what actually protects the data — a
   viewer's transaction is read-only and Postgres says no whatever the screen
   does — so none of this is security. It is about not wasting somebody's time,
   and not making a working product look broken.

   The first pass covered the boards: deals, leads, projects, the document
   ledger. This is the second, found by signing in as the seeded viewer and
   walking the screens they actually use. What it caught:

     - Contacts: edit, delete, add, import, and the Call/Text/Email/Note strip,
       every one of which writes.
     - Companies: add, rename and remove on every row.
     - Tasks: the whole "Add a task" composer, which also appears on a contact
       card and on a job's schedule.

   Written against the source because these are client components with no
   server to ask. Crude, and it is the difference between a rule that holds and
   a rule that was true the day somebody wrote it down.
*/
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(`${process.cwd()}/${p}`, "utf8");

/** Every screen that has been through this pass. */
const GATED = [
  "src/app/(app)/deals/DealsBoard.tsx",
  "src/app/(app)/leads/LeadCardsSection.tsx",
  "src/app/(app)/projects/ProjectsView.tsx",
  "src/components/documents/DocumentLedgerView.tsx",
  "src/app/(app)/contacts/ContactsView.tsx",
  "src/app/(app)/companies/CompaniesView.tsx",
  "src/components/tasks/NewTaskForm.tsx",
  "src/app/(app)/inbox/InboxView.tsx",
  "src/components/tickets/TicketControls.tsx",
  "src/app/(app)/meetings/MeetingsView.tsx",
  "src/app/(app)/pricing/PricingView.tsx",
  "src/app/(app)/projects/[id]/ProjectDetail.tsx",
  "src/app/(app)/projects/[id]/RetainerCard.tsx",
  "src/app/(app)/voice-agents/VoiceAgentConsole.tsx",
  "src/components/ui/TrashCard.tsx",
];

describe("the screens a viewer meets", () => {
  it("all ask whether this reader may write", () => {
    for (const file of GATED) {
      /* Any of the three: a screen asks the gate that matches its door.
         `useCanWrite` for customer records, `useCanWriteMail` for the inbox,
         `useCanHandleMoney` for the price list — see `shell/Abilities`. */
      expect(read(file), `${file} consults no access gate at all`).toMatch(
        /use(CanWrite|CanWriteMail|CanHandleMoney)\(\)/
      );
    }
  });
});

describe("contacts", () => {
  const view = read("src/app/(app)/contacts/ContactsView.tsx");

  it("offers only the actions that look, not the ones that write", () => {
    /* Call, Text and Email each RECORD the outreach, and Note opens a form —
       for a viewer those submit and are refused. Revenue reads and changes
       nothing, so a viewer whose job is the numbers keeps it. */
    expect(view).toMatch(/const READ_ONLY_ACTIONS = new Set\(\["Revenue"\]\);/);
    expect(view).toMatch(/\.filter\(\(a\) => canWrite \|\| READ_ONLY_ACTIONS\.has\(a\.label\)\)/);
  });

  it("keeps the allow-list, not a deny-list", () => {
    /* A new action added to that strip is far likelier to write than not, so
       the default has to be "hidden until somebody says otherwise". */
    expect(view).not.toMatch(/WRITING_ACTIONS|NO_WRITE_ACTIONS/);
  });

  it("leaves the tools for looking alone", () => {
    /* Looking is the whole of this job. Taking away the tools for it would be
       the opposite failure to the one being fixed, and just as bad. Sort and
       filter are what sit beside the hidden buttons — there is no search box
       on this header, which is why this assertion originally failed. */
    expect(view).toMatch(/aria-label="Sort contacts"|<ArrowUpDown|SORTS/);
    expect(view).toMatch(/<Filter className/);
  });
});

describe("tasks", () => {
  it("hides the composer in the component, not at each of its callers", () => {
    const form = read("src/components/tasks/NewTaskForm.tsx");
    expect(form).toMatch(/if \(!canWrite\) return null;/);
    /* After every hook. An early return above one changes the hook order
       between renders, which React treats as a different component. */
    const gate = form.indexOf("if (!canWrite) return null;");
    expect(form.slice(gate)).not.toMatch(/use(State|Ref|Memo|Callback|KeptForm)\(/);
  });

  it("is reached from two screens, so gating it once covers both", () => {
    for (const file of ["src/app/(app)/tasks/TasksView.tsx", "src/app/(app)/contacts/ContactsView.tsx"]) {
      expect(read(file), `${file} no longer renders NewTaskForm`).toMatch(/NewTaskForm/);
    }
  });

  it("does not cover the job schedule, which has a task form of its own", () => {
    /* The gap this file found. Asserting three callers when there were two
       surfaced a whole second add-task control that the shared component's
       gate could never have reached. */
    const schedule = read("src/app/(app)/projects/[id]/ProjectSchedule.tsx");
    /* A JSX usage, not any mention — the comment explaining this gap names
       the component, and matching prose rather than code is how a guard test
       ends up asserting its own documentation. */
    expect(schedule).not.toMatch(/<NewTaskForm[\s/>]/);
    expect(schedule).toMatch(/canWrite && !addOpen && !editing/);
  });
});

describe("the inbox", () => {
  const inbox = read("src/app/(app)/inbox/InboxView.tsx");
  const tickets = read("src/components/tickets/TicketControls.tsx");

  /*
     The largest screen still untouched when this pass started: `InboxView` did
     not consult `useCanWrite` at ALL, so a view-only reader was offered
     compose, reply, forward, delete, restore, swipe-to-delete, the project
     filing menu and the full set of ticket controls.
  */
  it("offers no way to write a message", () => {
    expect(inbox).toMatch(/\{canWrite && \(\s*<button\s*onClick=\{\(\) => \{\s*setResumedDraft/);
    expect(inbox).toMatch(/Reply, Forward and Track as a ticket all write/);
  });

  it("does not offer a swipe that would spring back", () => {
    /* The same mistake as a draggable card a viewer cannot move. */
    expect(inbox).toMatch(/if \(m\.trashed \|\| !canWrite\) return <div key=\{m\.id\}>\{row\}<\/div>;/);
  });

  it("STILL SHOWS WHAT A TICKET IS, because that is information", () => {
    /*
       The point this file keeps having to make from the other side: hiding the
       writes must not blind the role. Which state a ticket is in, how urgent it
       is and whose desk it is on are facts about the conversation on screen.
       Three selects that refuse every change are what goes.
    */
    expect(tickets).toMatch(/if \(!canWrite\) \{[\s\S]{0,400}<TicketLine ticket=\{ticket\}/);
  });

  it("STILL SAYS WHICH JOB A CONVERSATION BELONGS TO", () => {
    /* The filing is part of reading the thread — it is the context the message
       makes sense in. The menu goes; the fact stays. */
    expect(inbox).toMatch(/A view-only reader is told WHICH job this conversation belongs to/);
    expect(inbox).toMatch(/if \(!canWrite\) \{\s*const filed = projects\.find/);
  });

  it("never puts `hidden` on an element that is also `flex`", () => {
    /* How the compose button was written first time. This project's failure
       log: the winner is decided by stylesheet order, not by intent. */
    expect(inbox).not.toMatch(/"btn-accent[^"]*flex[^"]*",\s*!canWrite && "hidden"/);
  });
});

describe("every screen with write controls has been through this pass", () => {
  /**
   * The sweep that ended the guessing.
   *
   * Finding these one at a time — a screenshot, a gap, a fix — was how the
   * first three rounds went, and it was never going to finish. This lists every
   * file that renders a server action and asserts each one either consults
   * `useCanWrite` or is on the list below with a reason.
   *
   * A new screen with a write control and no gate fails here, which is the
   * point: the next one should be caught by a test rather than by Bradley.
   */
  const EXEMPT: Record<string, string> = {
    // Decided by a stricter gate than "can this person write".
    "src/components/documents/RecordPayment.tsx": "useMaySettle — only finance confirms money arrived",
    "src/app/(app)/settings/BusinessCard.tsx": "manage_billing, with its own ReadOnly view",
    "src/app/(app)/settings/PaymentsCard.tsx": "manage_billing",
    "src/components/billing/BillingCard.tsx": "manage_billing",
    "src/components/billing/ReferralCard.tsx": "manage_billing",
    "src/app/(app)/settings/TeamCard.tsx": "manage_users",
    "src/app/(app)/settings/AutomationsCard.tsx": "canManage prop — manage_users",
    "src/app/(app)/settings/TemplatesCard.tsx": "canManage prop — manage_users",
    "src/app/(app)/settings/CustomFieldsCard.tsx": "canManage prop — manage_users",
    "src/components/tags/Tags.tsx": "canManageTags prop",
    // Not reachable by a signed-in viewer at all.
    "src/components/login/ResetRequestForm.tsx": "the public login page, where there is no session",
    // The reader's own account, which a viewer may absolutely change.
    "src/app/(app)/settings/SettingsForms.tsx": "own profile and password, plus workspace cards gated in page.tsx",
    // Writes nothing itself; the page decides.
    "src/app/(app)/settings/page.tsx": "composes the cards and gates the workspace ones",
    "src/app/(app)/projects/[id]/PayLinkButton.tsx": "a pay link for an invoice; sits inside gated document rows",
    "src/app/(app)/chat/ChatView.tsx": "asking the assistant a question, which a viewer may do",
  };

  it("leaves no screen unaccounted for", () => {
    const found = execSync(
      String.raw`grep -rl 'Action[,)]\|Action(' 'src/app/(app)' src/components --include='*.tsx' || true`,
      { cwd: process.cwd(), encoding: "utf8" }
    )
      .split("\n")
      .filter(Boolean);

    const asksSomething = (src: string) =>
      /use(CanWrite|CanWriteMail|CanHandleMoney|MaySettle)\(\)/.test(src);
    const ungated = found.filter((f) => !asksSomething(read(f)) && !(f in EXEMPT));
    expect(ungated, `these render a write and neither ask useCanWrite nor give a reason: ${ungated.join(", ")}`).toEqual([]);
  });

  it("keeps the exemptions honest — each one still exists", () => {
    /* An exemption for a file that has been deleted or renamed is a hole that
       looks like a decision. */
    for (const file of Object.keys(EXEMPT)) {
      expect(() => read(file), `${file} is exempted but no longer exists`).not.toThrow();
    }
  });
});
