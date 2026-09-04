"use client";

import { useActionState, useRef, useState } from "react";
import { useFormDisclosure } from "@/lib/form-disclosure";
import { Plus, ShieldCheck, UserMinus, Users } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Banner } from "@/components/ui/Banner";
import { Card, CardHeader, CardMeta } from "@/components/ui/Card";
import { clsx } from "@/lib/clsx";
import type { FormState } from "./actions";
import { inviteMemberAction, removeMemberAction, setMemberRoleAction } from "./team-actions";

/**
 * The people who can use this account.
 *
 * `manage_users` has been in the permissions matrix since roles were enforced,
 * granted to owner and admin, and until now nothing in the product used it — an
 * agency owner could not add the person who actually answers the phone. Every
 * other permission decision was theoretical while that was true.
 *
 * What each role means is written on the screen rather than left for somebody
 * to infer from being refused. A limit you only discover by hitting it reads as
 * a fault, and a permission you only discover by hitting it reads as a bug.
 */

export type TeamMember = {
  id: string;
  name: string;
  email: string;
  role: string;
  initials: string;
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
  members,
  canManage,
  assignable,
}: {
  members: TeamMember[];
  /** Whether the reader may manage people at all — `manage_users`. */
  canManage: boolean;
  /** The roles this reader is allowed to hand out, worked out on the server. */
  assignable: readonly string[];
}) {
  const [inviteState, invite, inviting] = useActionState<FormState, FormData>(
    inviteMemberAction,
    undefined,
  );
  const [roleState, changeRole, changingRole] = useActionState<FormState, FormData>(
    setMemberRoleAction,
    undefined,
  );
  const [removeState, remove, removing] = useActionState<FormState, FormData>(
    removeMemberAction,
    undefined,
  );
  /* A new colleague starts with the least access on offer. `assignable` arrives
     in the matrix's own order, most powerful first, so the last entry is it —
     read from the list rather than named, so the default cannot become a role
     this reader is not allowed to hand out. */
  const leastPrivileged = assignable[assignable.length - 1];

  const [inviteOpen, openInvite, closeInvite] = useFormDisclosure(inviteState, (s) =>
    Boolean(s?.ok),
  );

  return (
    <>
      <Card>
        <CardHeader
          title="People"
          icon={<Users className="h-[18px] w-[18px] text-accent" />}
          action={
            <CardMeta value={members.length}>{members.length === 1 ? "person" : "people"}</CardMeta>
          }
        />

        {/* One banner slot for both row actions. They are the same kind of
            answer about the same list, and two stacked strips would push the
            list down every time somebody changed a role. */}
        <div className="flex flex-col gap-2">
          <Banner state={roleState} />
          <Banner state={removeState} />
        </div>

        <ul className="mt-1 flex flex-col gap-2">
          {members.map((m) => (
            <MemberRow
              key={m.id}
              member={m}
              assignable={assignable}
              canManage={m.canManage}
              busy={changingRole || removing}
              onChangeRole={changeRole}
              onRemove={remove}
            />
          ))}
        </ul>
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

          {/* Closed by default, because the list is what somebody came to see
              and three empty fields under it are three fields of noise on every
              visit. The result of the last invitation still shows while closed —
              collapsing the form should not swallow the answer. */}
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
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-muted">Full name</span>
                  <input name="name" required className="field-input" />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-muted">Email address</span>
                  <input name="email" type="email" required className="field-input" />
                </label>
              </div>

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
            {ROLE_BLURB.member} An owner or admin on this account can change that.
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
  onChangeRole,
  onRemove,
}: {
  member: TeamMember;
  assignable: readonly string[];
  canManage: boolean;
  busy: boolean;
  onChangeRole: (formData: FormData) => void;
  onRemove: (formData: FormData) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const roleForm = useRef<HTMLFormElement | null>(null);
  const tone = ROLE_TONE[member.role] ?? ROLE_TONE.member;

  return (
    <li
      className="flex flex-wrap items-center gap-3 rounded-xl px-3.5 py-3"
      style={{
        background: member.isYou ? "var(--accent-soft)" : "var(--surface-2)",
      }}
    >
      <Avatar initials={member.initials} color={member.isYou ? "blue" : "teal"} size="sm" />

      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-sm font-medium">
          {member.name}
          {member.isYou && <span className="ml-2 text-xs font-normal text-faint">you</span>}
        </p>
        <p className="mt-0.5 truncate text-xs text-faint">{member.email}</p>
      </div>

      {/*
          A read-only role stays on the name's line. It is one short word and
          leaves the name plenty of room, so wrapping it would be a second line
          spent on sixty pixels of text.
      */}
      {!canManage && (
        <span
          className="shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold capitalize"
          style={{ background: tone.soft, color: tone.color }}
        >
          {member.role}
        </span>
      )}

      {/*
          The controls, on the other hand, take a line of their own on a phone.

          `w-full` is what makes the wrap happen: the row is `flex-wrap`, so a
          full-width group cannot share the line and the name gets the whole of
          the first one. Without it the identity block was the only flexible
          column and absorbed every pixel the select and the remove button
          wanted — "Sam Ca…" beside "sam.cart…", which is the same defect the
          Reports deal row had. Measure the content, then decide the container.
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
                 server is the thing that decides — a select that looked applied
                 but was not would be worse than either. */
              onChange={() => roleForm.current?.requestSubmit()}
              className="focus-ring rounded-lg px-2.5 py-1.5 text-xs font-semibold capitalize disabled:opacity-60"
              style={{ background: tone.soft, color: tone.color }}
            >
              {/* The member's current role is always offered, even where it is
                  not one this person could assign — otherwise the control would
                  silently show the wrong value for an owner an admin is looking
                  at. */}
              {(assignable.includes(member.role) ? assignable : [member.role, ...assignable]).map(
                (role) => (
                  <option key={role} value={role} className="capitalize">
                    {role}
                  </option>
                ),
              )}
            </select>
          </form>

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
               client's whole record set, and a single misplaced tap on a phone
               should not be able to do that. */
            <button
              type="button"
              onClick={() => setConfirming(true)}
              aria-label={`Remove ${member.name}`}
              className={clsx(
                "btn-soft focus-ring shrink-0 rounded-lg p-2 text-muted transition-colors hover:text-red",
              )}
            >
              <UserMinus className="h-4 w-4" />
            </button>
          )}
        </div>
      )}
    </li>
  );
}
