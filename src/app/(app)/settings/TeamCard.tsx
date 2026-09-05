"use client";

import { useActionState, useRef, useState } from "react";
import { Mail, Pencil, Phone, Plus, ShieldCheck, UserMinus, Users } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Banner } from "@/components/ui/Banner";
import { Card, CardHeader, CardMeta } from "@/components/ui/Card";
import { clsx } from "@/lib/clsx";
import { useFormDisclosure } from "@/lib/form-disclosure";
import type { DirectoryGroup } from "@/server/directory";
import type { FormState } from "./actions";
import {
  inviteMemberAction,
  removeMemberAction,
  setMemberRoleAction,
  updateStaffAction,
} from "./team-actions";

/**
 * The company directory.
 *
 * `manage_users` had been in the permissions matrix since roles were enforced,
 * granted to owner and admin, with nothing in the product using it — an agency
 * owner could not add the person who actually answers the phone. This is that
 * screen, and then the other half of it: not just who may sign in, but who they
 * are. Department, position, how to reach them, and what they are responsible
 * for.
 *
 * Filed by department rather than listed flat. A flat list is one you have to
 * read all of; a filed one is one you can scan to the right group and stop —
 * which is the whole difference between a table of users and a directory.
 *
 * What each ROLE means is written on screen rather than left for somebody to
 * infer from being refused. A permission you only discover by hitting it reads
 * as a bug.
 */

export type TeamMember = {
  id: string;
  name: string;
  email: string;
  role: string;
  initials: string;
  department: string | null;
  jobTitle: string | null;
  phone: string | null;
  scope: string | null;
  /** True for the person reading the page. */
  isYou: boolean;
  /**
   * Whether the reader may change or remove THIS person.
   *
   * Decided on the server, from the capability matrix, and sent as an answer
   * rather than as the inputs to one. The component knowing "am I an owner?"
   * and re-deriving the rule is a second copy of it in a second language, and
   * it is the copy that decides whether the control is drawn — so when the two
   * disagree the symptom is a button that submits and is refused.
   */
  canManage: boolean;
};

const ROLE_TONE: Record<string, { color: string; soft: string }> = {
  owner: { color: "var(--accent)", soft: "var(--accent-soft)" },
  admin: { color: "var(--purple)", soft: "var(--purple-soft)" },
  member: { color: "var(--text-muted)", soft: "var(--raise)" },
};

/**
 * What each role actually means, in the words a customer would use.
 *
 * On the screen because a permission somebody only discovers by being refused
 * reads as a bug. These describe the grants in `permissions.ts` and have to be
 * kept true to them by hand — which is why they say what the role is FOR rather
 * than listing capability names that would go stale silently.
 */
const ROLE_BLURB: Record<string, string> = {
  owner: "Everything, including the subscription and the card.",
  admin: "Everything except billing — adds people and workspaces.",
  member: "Works inside the CRM. No billing, workspaces or people.",
};

export function TeamCard({
  groups,
  headcount,
  canManage,
  assignable,
}: {
  /** People filed by department, unfiled last. Grouped on the server. */
  groups: DirectoryGroup<TeamMember>[];
  headcount: number;
  /** Whether the reader may manage people at all — `manage_users`. */
  canManage: boolean;
  /** The roles this reader is allowed to hand out, worked out on the server. */
  assignable: readonly string[];
}) {
  const [inviteState, invite, inviting] = useActionState<FormState, FormData>(
    inviteMemberAction,
    undefined
  );
  const [roleState, changeRole, changingRole] = useActionState<FormState, FormData>(
    setMemberRoleAction,
    undefined
  );
  const [removeState, remove, removing] = useActionState<FormState, FormData>(
    removeMemberAction,
    undefined
  );
  const [detailState, saveDetails, savingDetails] = useActionState<FormState, FormData>(
    updateStaffAction,
    undefined
  );

  /* A new colleague starts with the least access on offer. `assignable` arrives
     in the matrix's own order, most powerful first, so the last entry is it —
     read from the list rather than named, so the default cannot become a role
     this reader is not allowed to hand out. */
  const leastPrivileged = assignable[assignable.length - 1];

  const [inviteOpen, openInvite, closeInvite] = useFormDisclosure(inviteState, (s) =>
    Boolean(s?.ok)
  );

  return (
    <>
      <Card>
        <CardHeader
          title="Directory"
          icon={<Users className="h-[18px] w-[18px] text-accent" />}
          action={<CardMeta value={headcount}>{headcount === 1 ? "person" : "people"}</CardMeta>}
        />

        {/* One banner area for every row action. They are the same kind of
            answer about the same list, and three stacked strips would push the
            directory down the screen each time somebody changed anything. */}
        <div className="flex flex-col gap-2 empty:hidden">
          <Banner state={roleState} />
          <Banner state={removeState} />
          <Banner state={detailState} />
        </div>

        <div className="mt-1 flex flex-col gap-4">
          {groups.map((group) => (
            <section key={group.department ?? "__unfiled"}>
              {/*
                  The department heading.

                  "Not filed yet" rather than a dash or a blank: on the day
                  somebody joins they have no department, and that is exactly
                  who everybody is looking up. Naming the state also makes it
                  read as a gap to close rather than as a category.
              */}
              <p className="mb-1.5 flex items-center gap-2 px-0.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: group.department ? "var(--accent)" : "var(--amber)" }}
                  aria-hidden
                />
                {group.department ?? "Not filed yet"}
                <span className="font-normal tracking-normal">({group.people.length})</span>
              </p>
              <ul className="flex flex-col gap-2">
                {group.people.map((m) => (
                  <MemberRow
                    key={m.id}
                    member={m}
                    assignable={assignable}
                    canManage={m.canManage}
                    busy={changingRole || removing || savingDetails}
                    detailState={detailState}
                    onChangeRole={changeRole}
                    onRemove={remove}
                    onSaveDetails={saveDetails}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      </Card>

      {canManage && (
        <Card>
          <CardHeader
            title="Add someone"
            icon={<Plus className="h-[18px] w-[18px] text-accent" />}
            action={
              !inviteOpen && (
                <button
                  type="button"
                  onClick={openInvite}
                  className="btn-accent focus-ring rounded-xl px-4 py-2 text-xs font-semibold"
                >
                  Invite
                </button>
              )
            }
          />

          {/* Closed by default, because the directory is what somebody came to
              see and five empty fields under it are five fields of noise on
              every visit. The result of the last invitation still shows while
              closed — collapsing the form should not swallow the answer. */}
          {!inviteOpen && !inviteState && (
            <p className="text-xs text-faint">
              They get an email with a link to choose their own password. Nothing is sent in plain
              text, and the link expires in an hour.
            </p>
          )}
          {!inviteOpen && inviteState && <Banner state={inviteState} />}

          {inviteOpen && (
            <form action={invite} className="space-y-4">
              <Banner state={inviteState} />
              <div className="grid grid-cols-1 gap-4 @min-[440px]:grid-cols-2">
                <Field label="Full name" name="name" required />
                <Field label="Email address" name="email" type="email" required />
                <Field label="Department" name="department" placeholder="Sales" />
                <Field label="Position" name="jobTitle" placeholder="Account Executive" />
              </div>
              <p className="text-xs text-faint">
                Department and position are optional — they file the person in the directory, and
                can be filled in later.
              </p>

              <fieldset>
                <legend className="mb-1.5 text-xs font-medium text-muted">Role</legend>
                <div className="flex flex-col gap-1.5">
                  {assignable.map((role) => (
                    <label
                      key={role}
                      className="flex cursor-pointer items-start gap-2.5 rounded-xl px-3 py-2.5"
                      style={{ background: "var(--surface-2)" }}
                    >
                      <input
                        type="radio"
                        name="role"
                        value={role}
                        defaultChecked={role === leastPrivileged}
                        className="mt-0.5 accent-[var(--accent)]"
                      />
                      <span className="min-w-0 leading-tight">
                        <span className="block text-sm font-medium capitalize">{role}</span>
                        <span className="mt-0.5 block text-xs text-faint">{ROLE_BLURB[role]}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={closeInvite}
                  className="btn-soft focus-ring rounded-xl px-4 py-2.5 text-sm font-medium text-muted"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={inviting}
                  className="btn-accent focus-ring flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-60"
                >
                  <Plus className="h-4 w-4" />
                  {inviting ? "Sending…" : "Send invitation"}
                </button>
              </div>
            </form>
          )}
        </Card>
      )}

      {!canManage && (
        <Card>
          <CardHeader
            title="Your access"
            icon={<ShieldCheck className="h-[18px] w-[18px] text-accent" />}
          />
          <p className="text-xs text-faint">
            {ROLE_BLURB.member} An owner or admin on this account can change that, and can fill in
            your position and scope of work.
          </p>
        </Card>
      )}
    </>
  );
}

function MemberRow({
  member,
  assignable,
  canManage,
  busy,
  detailState,
  onChangeRole,
  onRemove,
  onSaveDetails,
}: {
  member: TeamMember;
  assignable: readonly string[];
  canManage: boolean;
  busy: boolean;
  detailState: FormState;
  onChangeRole: (formData: FormData) => void;
  onRemove: (formData: FormData) => void;
  onSaveDetails: (formData: FormData) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [editing, openEdit, closeEdit] = useFormDisclosure(detailState, (s) => Boolean(s?.ok));
  const roleForm = useRef<HTMLFormElement | null>(null);
  const tone = ROLE_TONE[member.role] ?? ROLE_TONE.member;

  return (
    <li
      className="rounded-xl px-3.5 py-3"
      style={{ background: member.isYou ? "var(--accent-soft)" : "var(--surface-2)" }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Avatar initials={member.initials} color={member.isYou ? "blue" : "teal"} size="sm" />

        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-sm font-medium">
            {member.name}
            {member.isYou && <span className="ml-2 text-xs font-normal text-faint">you</span>}
          </p>
          {/* The position, which is what a directory is read for. Names the gap
              rather than rendering an empty line. */}
          <p className="mt-0.5 truncate text-xs text-faint">
            {member.jobTitle ?? "No position set"}
          </p>
        </div>

        {/* A read-only role stays on the name's line. It is one short word and
            leaves the name plenty of room, so wrapping it would be a second
            line spent on sixty pixels of text. */}
        {!canManage && (
          <span
            className="shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold capitalize"
            style={{ background: tone.soft, color: tone.color }}
          >
            {member.role}
          </span>
        )}

        {/*
            The controls take a line of their own on a phone.

            `w-full` is what makes the wrap happen: the row is `flex-wrap`, so a
            full-width group cannot share the line and the name gets the whole
            of the first one. Without it the identity block was the only
            flexible column and absorbed every pixel the controls wanted —
            "Sam Ca…" beside "sam.cart…", the same defect the Reports deal row
            had. Measure the content, then decide the container.
        */}
        {canManage && (
          <div className="flex w-full items-center justify-end gap-1.5 @min-[440px]:w-auto">
            <form action={onChangeRole} ref={roleForm} className="shrink-0">
              <input type="hidden" name="userId" value={member.id} />
              <label className="sr-only" htmlFor={`role-${member.id}`}>
                Role for {member.name}
              </label>
              <select
                id={`role-${member.id}`}
                name="role"
                defaultValue={member.role}
                disabled={busy}
                /* Submits on change rather than pairing every row with a Save
                   button. The banner above the list says what happened, and the
                   server is the thing that decides — a select that looked
                   applied but was not would be worse than either. */
                onChange={() => roleForm.current?.requestSubmit()}
                className="focus-ring rounded-lg px-2.5 py-1.5 text-xs font-semibold capitalize disabled:opacity-60"
                style={{ background: tone.soft, color: tone.color }}
              >
                {/* The member's current role is always offered, even where it is
                    not one this person could assign — otherwise the control
                    would silently show the wrong value for an owner an admin is
                    looking at. */}
                {(assignable.includes(member.role)
                  ? assignable
                  : [member.role, ...assignable]
                ).map((role) => (
                  <option key={role} value={role} className="capitalize">
                    {role}
                  </option>
                ))}
              </select>
            </form>

            {!editing && (
              <button
                type="button"
                onClick={openEdit}
                aria-label={`Edit ${member.name}'s details`}
                className="btn-soft focus-ring shrink-0 rounded-lg p-2 text-muted transition-colors hover:text-accent"
              >
                <Pencil className="h-4 w-4" />
              </button>
            )}

            {confirming ? (
              <span className="flex shrink-0 items-center gap-1.5">
                <form action={onRemove}>
                  <input type="hidden" name="userId" value={member.id} />
                  <button
                    type="submit"
                    disabled={busy}
                    className="focus-ring rounded-lg px-2.5 py-1.5 text-xs font-semibold disabled:opacity-60"
                    style={{ background: "var(--red-soft)", color: "var(--red)" }}
                  >
                    Remove
                  </button>
                </form>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="btn-soft focus-ring rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted"
                >
                  Cancel
                </button>
              </span>
            ) : (
              /* Two steps, in place. Removing somebody cuts their access to a
                 client's whole record set, and a single misplaced tap on a
                 phone should not be able to do that. */
              <button
                type="button"
                onClick={() => setConfirming(true)}
                aria-label={`Remove ${member.name}`}
                className={clsx(
                  "btn-soft focus-ring shrink-0 rounded-lg p-2 text-muted transition-colors hover:text-red"
                )}
              >
                <UserMinus className="h-4 w-4" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Contact details and scope, under the name rather than beside it. Three
          short facts on one line is three columns fighting for a phone's width;
          underneath, each gets the whole of it. */}
      {!editing && <Details member={member} />}

      {editing && (
        <form action={onSaveDetails} className="mt-3 space-y-3 border-t border-[var(--border)] pt-3">
          <input type="hidden" name="userId" value={member.id} />
          <div className="grid grid-cols-1 gap-3 @min-[440px]:grid-cols-2">
            <Field label="Department" name="department" defaultValue={member.department ?? ""} />
            <Field label="Position" name="jobTitle" defaultValue={member.jobTitle ?? ""} />
            <Field label="Phone or extension" name="phone" defaultValue={member.phone ?? ""} />
          </div>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Scope of work</span>
            <textarea
              name="scope"
              rows={3}
              defaultValue={member.scope ?? ""}
              placeholder="What they are responsible for"
              className="field-input resize-y"
            />
          </label>
          <p className="text-xs text-faint">
            Leave a field empty to clear it. Their email address is theirs to change, under
            Account.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={closeEdit}
              className="btn-soft focus-ring rounded-xl px-4 py-2 text-xs font-medium text-muted"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="btn-accent focus-ring rounded-xl px-4 py-2 text-xs font-semibold disabled:opacity-60"
            >
              {busy ? "Saving…" : "Save details"}
            </button>
          </div>
        </form>
      )}
    </li>
  );
}

/** Email, phone and scope. Each line appears only when there is something in it. */
function Details({ member }: { member: TeamMember }) {
  return (
    <div className="mt-2 flex flex-col gap-1.5 pl-11">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-faint">
        <a
          href={`mailto:${member.email}`}
          className="focus-ring flex min-w-0 items-center gap-1.5 rounded transition-colors hover:text-accent"
        >
          <Mail className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">{member.email}</span>
        </a>
        {member.phone && (
          <a
            href={`tel:${member.phone.replace(/\s+/g, "")}`}
            className="focus-ring flex min-w-0 items-center gap-1.5 rounded transition-colors hover:text-accent"
          >
            <Phone className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">{member.phone}</span>
          </a>
        )}
      </div>
      {member.scope && (
        <p className="whitespace-pre-line text-xs leading-relaxed text-muted">{member.scope}</p>
      )}
    </div>
  );
}

function Field({
  label,
  name,
  type = "text",
  defaultValue,
  placeholder,
  required,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted">{label}</span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
        className="field-input"
      />
    </label>
  );
}
