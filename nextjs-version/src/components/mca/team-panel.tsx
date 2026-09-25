"use client"

import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table"
import * as React from "react"
import Link from "next/link"
import {
  AlertCircle,
  ArrowRight,
  Check,
  Copy,
  LoaderCircle,
  MailPlus,
  Search,
  UsersRound,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatRole, RequestError, requestJson } from "@/lib/mca/client"
import { normalizeTeamInvitationInput, validateTeamInvitation } from "@/lib/mca/invitations-validation"
import { OwnershipTransfer } from "@/components/mca/ownership-transfer"
import {
  assignableRoles,
  canDeactivateMember,
  canEditMember,
  eligibleManagers,
  filterTeam,
  invitationState,
  roleDescriptions,
  type TeamView,
} from "@/lib/mca/team-view"
import type {
  InvitationResult,
  MembershipSummary,
  Role,
  SessionResponse,
  WorkspaceSettings,
} from "@/lib/mca/types"

type Draft = {
  name: string
  email: string
  phone: string
  role: Role
  managerMembershipId: string
  senderAssociation: string
}
const emptyInvite: Draft = {
  name: "",
  email: "",
  phone: "",
  role: "rep",
  managerMembershipId: "",
  senderAssociation: "",
}
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again."
const dateLabel = (date: string) =>
  new Date(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })

export default function TeamSettingsPage() {
  const [members, setMembers] = React.useState<MembershipSummary[]>([])
  const [workspace, setWorkspace] = React.useState<WorkspaceSettings | null>(
    null
  )
  const [session, setSession] = React.useState<SessionResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState("")
  const [view, setView] = React.useState<TeamView>("active")
  const [query, setQuery] = React.useState("")
  const [role, setRole] = React.useState("all")
  const [manager, setManager] = React.useState("all")
  const [inviteOpen, setInviteOpen] = React.useState(false)
  const [selected, setSelected] = React.useState<MembershipSummary | null>(null)
  const [resending, setResending] = React.useState<string | null>(null)
  const resendLock = React.useRef(false)
  const focusTarget = React.useRef<HTMLElement | null>(null)
  const rosterRef = React.useRef<HTMLDivElement>(null)
  const restoreFocus = () => {
    if (focusTarget.current?.isConnected) focusTarget.current.focus()
    else
      rosterRef.current
        ?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
        ?.focus()
  }
  const load = React.useCallback(async () => {
    setRefreshing(true)
    try {
      const [data, settings, current] = await Promise.all([
        requestJson<MembershipSummary[] | { memberships: MembershipSummary[] }>(
          "/api/memberships"
        ),
        requestJson<WorkspaceSettings>("/api/workspace"),
        requestJson<SessionResponse>("/api/auth/session"),
      ])
      const list = Array.isArray(data) ? data : data.memberships
      setMembers(list)
      setWorkspace(settings)
      setSession(current)
      setError("")
      return list
    } catch (caught) {
      setError(message(caught))
      return null
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])
  React.useEffect(() => {
    void load()
  }, [load])
  const canManage = Boolean(session?.permissions?.canManageUsers)
  const canInvite =
    canManage && Boolean(session?.permissions?.actions.inviteUsers)
  const actor = session?.membership?.role
  const billingAdmin = actor === "admin" || actor === "super_admin"
  const active = members.filter((m) => m.status === "active").length
  const pending = members.filter((m) => m.status === "pending").length
  const occupied = active + pending,
    limit = workspace?.seatLimit ?? 0
  const visible = filterTeam(members, view, query, role, manager)
  const filtered = Boolean(query || role !== "all" || manager !== "all")
  const reset = () => {
    setQuery("")
    setRole("all")
    setManager("all")
  }
  function openMember(member: MembershipSummary, target: HTMLElement) {
    focusTarget.current = target
    setSelected(member)
  }
  async function resend(member: MembershipSummary) {
    if (!member.pendingInvitationId || resendLock.current) return
    resendLock.current = true
    setResending(member.id)
    try {
      await requestJson(
        `/api/invitations/${member.pendingInvitationId}/resend`,
        { method: "POST" }
      )
      toast.success(`Invitation sent to ${member.email}`)
    } catch (caught) {
      toast.error(message(caught))
    } finally {
      await load()
      setResending(null)
      resendLock.current = false
    }
  }
  if (loading)
    return (
      <StateBox
        title="Loading your team"
        icon={<LoaderCircle className="animate-spin" />}
      />
    )
  if (!workspace || !session)
    return (
      <StateBox
        title="Team unavailable"
        detail={error}
        icon={<AlertCircle />}
        action={<Button onClick={() => void load()}>Try again</Button>}
      />
    )
  return (
    <div ref={rosterRef} className="space-y-6">
      {billingAdmin && <OwnershipTransfer members={members} onTransferred={()=>void load()}/>}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Team</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The people behind your company.
          </p>
        </div>
        {canInvite && (
          <Button
            onClick={() => {
              focusTarget.current = document.activeElement as HTMLElement
              setInviteOpen(true)
            }}
            disabled={occupied >= limit}
          >
            <MailPlus className="size-4" />
            Invite employee
          </Button>
        )}
      </div>
      <div className="rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <span>
              <strong className="tabular-nums">{active}</strong>{" "}
              <span className="text-muted-foreground">active members</span>
            </span>
            <span>
              <strong className="tabular-nums">{pending}</strong>{" "}
              <span className="text-muted-foreground">
                reserved invitations
              </span>
            </span>
            <span>
              <strong className="tabular-nums">
                {Math.max(0, limit - occupied)}
              </strong>{" "}
              <span className="text-muted-foreground">seats available</span>
            </span>
          </div>
          <span className="text-xs text-muted-foreground">
            {occupied} of {limit} seats
          </span>
        </div>
        <div
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"
          role="meter"
          aria-label="Company seats reserved"
          aria-valuemin={0}
          aria-valuemax={Math.max(limit, occupied)}
          aria-valuenow={occupied}
        >
          <div
            className="h-full rounded-full bg-primary"
            style={{
              width: `${Math.min(100, (occupied / Math.max(1, limit)) * 100)}%`,
            }}
          />
        </div>
        {occupied >= limit && (
          <p className="mt-3 text-sm text-muted-foreground">
            {occupied > limit
              ? "Your team is above its plan limit. Existing members keep access."
              : "All seats are reserved, including pending invitations."}{" "}
            Free a seat or upgrade before inviting someone new.
            {billingAdmin && workspace.seatLimitManaged && (
              <>
                {" "}
                <Link
                  href="/settings/billing"
                  className="font-medium text-primary underline underline-offset-4"
                >
                  View plans
                </Link>
              </>
            )}
          </p>
        )}
      </div>
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 p-3 text-sm"
        >
          <span>{error}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={refreshing}
          >
            Retry
          </Button>
        </div>
      )}
      <div className="space-y-4">
        <Tabs
          value={view}
          onValueChange={(value) => setView(value as TeamView)}
        >
          <TabsList className="w-full sm:w-auto" aria-label="Team views">
            {(
              [
                ["active", "Members", active],
                ["pending", "Invitations", pending],
                ["deactivated", "Inactive", members.length - occupied],
              ] as const
            ).map(([key, label, count]) => (
              <TabsTrigger key={key} value={key} className="gap-2">
                {label}
                <span className="rounded bg-background/70 px-1.5 text-xs tabular-nums">
                  {count}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value={view} className="space-y-4">
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
                <Input
                  aria-label="Search team by name or email"
                  placeholder="Search by name or email…"
                  className="pl-9"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="flex gap-2">
                <Select value={role} onValueChange={setRole}>
                  <SelectTrigger aria-label="Filter by role" className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All roles</SelectItem>
                    {assignableRoles("super_admin").map((r) => (
                      <SelectItem key={r} value={r}>
                        {formatRole(r)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={manager} onValueChange={setManager}>
                  <SelectTrigger
                    aria-label="Filter by manager"
                    className="w-40"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All managers</SelectItem>
                    <SelectItem value="none">No manager</SelectItem>
                    {members
                      .filter(
                        (m) =>
                          members.some(
                            (person) => person.managerMembershipId === m.id
                          ) ||
                          eligibleManagers(members).some(
                            (person) => person.id === m.id
                          )
                      )
                      .map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <p role="status">
                {visible.length}{" "}
                {view === "pending"
                  ? visible.length === 1
                    ? "invitation"
                    : "invitations"
                  : visible.length === 1
                    ? "member"
                    : "members"}
                {refreshing ? " · Updating…" : ""}
              </p>
              {filtered && (
                <Button variant="ghost" size="sm" onClick={reset}>
                  Clear filters
                </Button>
              )}
            </div>
            {!visible.length ? (
              <StateBox
                icon={<UsersRound />}
                title={
                  filtered
                    ? "No matches"
                    : view === "pending"
                      ? "No pending invitations"
                      : view === "deactivated"
                        ? "No inactive members"
                        : "Your team starts here"
                }
                detail={
                  filtered
                    ? "Try another name, email, role, or manager."
                    : view === "pending"
                      ? "Invitations will appear here until employees join."
                      : view === "deactivated"
                        ? "Deactivated members stay here for your records."
                        : "Invite an employee to start working together."
                }
                action={
                  filtered ? (
                    <Button variant="outline" onClick={reset}>
                      Reset filters
                    </Button>
                  ) : canInvite &&
                    occupied < limit &&
                    view !== "deactivated" ? (
                    <Button onClick={() => setInviteOpen(true)}>
                      Invite employee
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <>
                <div className="hidden overflow-hidden rounded-xl border md:block">
                  <Table className="w-full text-sm">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="font-medium">Person</TableHead>
                        <TableHead className="font-medium">Role</TableHead>
                        <TableHead className="font-medium">
                          {view === "pending" ? "Invitation" : "Manager"}
                        </TableHead>
                        <TableHead>
                          <span className="sr-only">Actions</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visible.map((member) => (
                        <TableRow
                          key={member.id}
                          className="cursor-pointer"
                          onClick={(e) => {
                            if (!(e.target as HTMLElement).closest("button")) {
                              const button =
                                e.currentTarget.querySelector("button")
                              if (button) openMember(member, button)
                            }
                          }}
                        >
                          <TableCell>
                            <button
                              className="rounded text-left outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
                              onClick={(e) =>
                                openMember(member, e.currentTarget)
                              }
                            >
                              <Person
                                member={member}
                                self={session.membership?.id}
                              />
                            </button>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {formatRole(member.role)}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {view === "pending" ? (
                              <InvitationStatus member={member} />
                            ) : (
                              <span className="text-muted-foreground">
                                {members.find(
                                  (m) => m.id === member.managerMembershipId
                                )?.name ?? "No manager"}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            {view === "pending" &&
                            canInvite &&
                            member.pendingInvitationId ? (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={resending !== null}
                                onClick={() => void resend(member)}
                              >
                                {resending === member.id ? (
                                  <LoaderCircle className="size-4 animate-spin" />
                                ) : null}
                                {member.invitationDeliveryStatus === "failed"
                                  ? "Retry invite"
                                  : "Resend"}
                              </Button>
                            ) : (
                              <ArrowRight
                                className="ml-auto size-4 text-muted-foreground"
                                aria-hidden
                              />
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <div className="divide-y rounded-xl border md:hidden">
                  {visible.map((member) => (
                    <div className="p-4" key={member.id}>
                      <button
                        className="w-full rounded text-left focus-visible:outline-2 focus-visible:outline-ring"
                        onClick={(e) => openMember(member, e.currentTarget)}
                      >
                        <Person member={member} self={session.membership?.id} />
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                          <Badge variant="outline">
                            {formatRole(member.role)}
                          </Badge>
                          {view !== "pending" && (
                            <span className="text-muted-foreground">
                              {members.find(
                                (m) => m.id === member.managerMembershipId
                              )?.name ?? "No manager"}
                            </span>
                          )}
                        </div>
                      </button>
                      {view === "pending" && (
                        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                          <InvitationStatus member={member} />
                          {canInvite && member.pendingInvitationId && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={resending !== null}
                              onClick={() => void resend(member)}
                            >
                              {resending === member.id
                                ? "Sending…"
                                : member.invitationDeliveryStatus === "failed"
                                  ? "Retry invite"
                                  : "Resend"}
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </TabsContent>
        </Tabs>
      </div>
      <InviteDialog
        open={inviteOpen}
        close={() => setInviteOpen(false)}
        members={members}
        actor={actor}
        onRefresh={load}
        onReserved={() => {
          setView("pending")
          reset()
        }}
        restoreFocus={restoreFocus}
      />
      {selected && (
        <MemberSheet
          key={selected.id}
          member={members.find((m) => m.id === selected.id) ?? selected}
          members={members}
          actor={actor}
          self={session.membership?.id}
          canManage={canManage}
          onRefresh={load}
          close={() => setSelected(null)}
          restoreFocus={restoreFocus}
        />
      )}
    </div>
  )
}

function Person({
  member,
  self,
}: {
  member: MembershipSummary
  self?: string
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span
        aria-hidden
        className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
      >
        {member.name
          .trim()
          .split(/\s+/)
          .map((n) => n[0])
          .slice(0, 2)
          .join("")
          .toUpperCase()}
      </span>
      <div className="min-w-0">
        <p className="break-words font-medium">
          {member.name}
          {member.id === self && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              You
            </span>
          )}
        </p>
        <p className="break-all text-xs text-muted-foreground">
          {member.email}
        </p>
      </div>
    </div>
  )
}
function InvitationStatus({ member }: { member: MembershipSummary }) {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000)
    return () => window.clearInterval(timer)
  }, [])
  const state = invitationState(member, now)
  return (
    <div className="space-y-1">
      <Badge
        variant={state === "Delivery failed" ? "destructive" : "secondary"}
      >
        {state}
      </Badge>
      {member.invitationExpiresAt && (
        <p className="text-xs text-muted-foreground">
          {new Date(member.invitationExpiresAt).getTime() <= now
            ? "Expired"
            : "Expires"}{" "}
          {dateLabel(member.invitationExpiresAt)}
        </p>
      )}
    </div>
  )
}
function Field({
  label,
  error,
  required,
  children,
}: {
  label: string
  error?: string
  required?: boolean
  children: React.ReactElement<{
    id?: string
    "aria-invalid"?: boolean
    "aria-describedby"?: string
    "aria-required"?: boolean
  }>
}) {
  const id = React.useId()
  const errorId = `${id}-error`
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label}
        {required ? <span className="sr-only"> (required)</span> : null}
      </Label>
      {React.cloneElement(children, {
        id,
        "aria-invalid": Boolean(error),
        "aria-describedby": error ? errorId : undefined,
        "aria-required": required,
      })}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
function RoleSelect({
  value,
  onChange,
  actor,
  disabled,
  id,
}: {
  value: Role
  onChange: (role: Role) => void
  actor?: Role
  disabled?: boolean
  id?: string
}) {
  const roles = assignableRoles(actor)
  return (
    <div className="space-y-2">
      <Select
        value={value}
        onValueChange={(r) => onChange(r as Role)}
        disabled={disabled}
      >
        <SelectTrigger id={id} aria-label="Role" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(roles.includes(value) ? roles : [...roles, value]).map((r) => (
            <SelectItem key={r} value={r} disabled={!roles.includes(r)}>
              {formatRole(r)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {roleDescriptions[value]}
      </p>
    </div>
  )
}
function ManagerSelect({
  value,
  onChange,
  members,
  memberId,
  disabled,
  id,
}: {
  value: string
  onChange: (id: string) => void
  members: MembershipSummary[]
  memberId?: string
  disabled?: boolean
  id?: string
}) {
  const managers = eligibleManagers(members, memberId)
  const unavailable = value && !managers.some((m) => m.id === value)
  return (
    <Select
      value={value || "none"}
      onValueChange={(v) => onChange(v === "none" ? "" : v)}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-label="Manager" className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">No manager</SelectItem>
        {unavailable && (
          <SelectItem value={value} disabled>
            {members.find((m) => m.id === value)?.name ?? "Unavailable manager"}{" "}
            (unavailable)
          </SelectItem>
        )}
        {managers.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {m.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
function StateBox({
  icon,
  title,
  detail,
  action,
}: {
  icon: React.ReactNode
  title: string
  detail?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-6 text-center">
      <span className="text-muted-foreground [&>svg]:size-6">{icon}</span>
      <div>
        <h3 className="font-medium">{title}</h3>
        {detail && (
          <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
        )}
      </div>
      {action}
    </div>
  )
}

function InviteDialog({
  open,
  close,
  members,
  actor,
  onRefresh,
  onReserved,
  restoreFocus,
}: {
  open: boolean
  close: () => void
  members: MembershipSummary[]
  actor?: Role
  onRefresh: () => Promise<MembershipSummary[] | null>
  onReserved: () => void
  restoreFocus: () => void
}) {
  const [draft, setDraft] = React.useState<Draft>(emptyInvite)
  const [busy, setBusy] = React.useState(false)
  const lock = React.useRef(false)
  const [error, setError] = React.useState("")
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>({})
  const [reserved, setReserved] = React.useState(false)
  const dirty = JSON.stringify(draft) !== JSON.stringify(emptyInvite)
  function dismiss() {
    if (!busy && (!dirty || window.confirm("Discard this invitation draft?"))) {
      setDraft(emptyInvite)
      setError("")
      setFieldErrors({})
      setReserved(false)
      close()
    }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (lock.current) return
    const nextErrors = validateTeamInvitation(draft)
    if (Object.keys(nextErrors).length) {
      setFieldErrors(nextErrors)
      setError("Review the highlighted fields.")
      return
    }
    lock.current = true
    setBusy(true)
    setError("")
    setFieldErrors({})
    setReserved(false)
    const payload = normalizeTeamInvitationInput(draft)
    try {
      const result = await requestJson<InvitationResult>("/api/invitations", {
        method: "POST",
        body: JSON.stringify(payload),
      })
      toast.success(
        result.delivery === "preview"
          ? "Invitation created in preview mode"
          : "Invitation sent"
      )
      setDraft(emptyInvite)
      close()
      onReserved()
      await onRefresh()
    } catch (caught) {
      const list = await onRefresh()
      const exists = (list ?? members).some(
        (m) =>
          m.status === "pending" &&
          m.email.toLowerCase() === payload.email.toLowerCase()
      )
      setReserved(exists)
      setFieldErrors(caught instanceof RequestError ? caught.fieldErrors ?? {} : {})
      setError(
        `${message(caught)}${exists ? " A seat is reserved for this employee. Retry delivery from Invitations." : ""}`
      )
      if (exists) onReserved()
    } finally {
      setBusy(false)
      lock.current = false
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) dismiss()
      }}
    >
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          restoreFocus()
        }}
      >
        <form noValidate onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Invite an employee</DialogTitle>
            <DialogDescription>
              Send an invitation to join your company. One seat is reserved
              until they join.
            </DialogDescription>
          </DialogHeader>
          <fieldset disabled={busy} className="my-5 space-y-4">
            <Field label="Full name" required error={fieldErrors.name?.[0]}>
              <Input
                autoComplete="name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            <Field label="Email address" required error={fieldErrors.email?.[0]}>
              <Input
                type="email"
                autoComplete="email"
                value={draft.email}
                onChange={(e) => {
                  setDraft({ ...draft, email: e.target.value })
                  setReserved(false)
                }}
              />
            </Field>
            <Field label="Role" error={fieldErrors.role?.[0]}>
              <RoleSelect
                value={draft.role}
                actor={actor}
                onChange={(role) => setDraft({ ...draft, role })}
              />
            </Field>
            <details className="rounded-lg border p-3">
              <summary className="cursor-pointer text-sm font-medium">
                Optional details
              </summary>
              <div className="mt-4 space-y-4">
                <Field label="Phone" error={fieldErrors.phone?.[0]}>
                  <Input
                    type="tel"
                    value={draft.phone}
                    onChange={(e) =>
                      setDraft({ ...draft, phone: e.target.value })
                    }
                  />
                </Field>
                <Field label="Manager">
                  <ManagerSelect
                    value={draft.managerMembershipId}
                    members={members}
                    onChange={(managerMembershipId) =>
                      setDraft({ ...draft, managerMembershipId })
                    }
                  />
                </Field>
                <Field label="Sender association" error={fieldErrors.senderAssociation?.[0]}>
                  <Input
                    placeholder="Sender ID"
                    value={draft.senderAssociation}
                    onChange={(e) =>
                      setDraft({ ...draft, senderAssociation: e.target.value })
                    }
                  />
                </Field>
              </div>
            </details>
          </fieldset>
          {error && (
            <p role="alert" className="mb-4 text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={dismiss}
            >
              Cancel
            </Button>
            {reserved ? (
              <Button
                type="button"
                onClick={() => {
                  close()
                  onReserved()
                }}
              >
                View invitation
              </Button>
            ) : (
              <Button type="submit" disabled={busy}>
                {busy ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <MailPlus className="size-4" />
                )}
                Send invitation
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function MemberSheet({
  member,
  members,
  actor,
  self,
  canManage,
  close,
  onRefresh,
  restoreFocus,
}: {
  member: MembershipSummary
  members: MembershipSummary[]
  actor?: Role
  self?: string
  canManage: boolean
  close: () => void
  onRefresh: () => Promise<MembershipSummary[] | null>
  restoreFocus: () => void
}) {
  const initial = {
    name: member.name,
    phone: member.phone ?? "",
    role: member.role,
    managerMembershipId: member.managerMembershipId ?? "",
    senderAssociation: member.senderAssociation ?? "",
  }
  const [draft, setDraft] = React.useState(initial)
  const [saved, setSaved] = React.useState(initial)
  const [busy, setBusy] = React.useState(false)
  const lock = React.useRef(false)
  const [error, setError] = React.useState("")
  const [confirm, setConfirm] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const editable = canEditMember(member, canManage, actor)
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const lastSuper =
    member.role === "super_admin" &&
    !members.some(
      (m) =>
        m.id !== member.id && m.role === "super_admin" && m.status === "active"
    )
  function dismiss() {
    if (!busy && (!dirty || window.confirm("Discard unsaved changes?"))) close()
  }
  React.useEffect(() => {
    if (!dirty) return
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", prevent)
    return () => window.removeEventListener("beforeunload", prevent)
  }, [dirty])
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError("")
    try {
      await requestJson(`/api/memberships/${member.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          ...draft,
          phone: draft.phone || null,
          managerMembershipId: draft.managerMembershipId || null,
          senderAssociation: draft.senderAssociation || null,
        }),
      })
      setSaved(draft)
      toast.success("Employee details saved")
      await onRefresh()
      close()
    } catch (caught) {
      setError(message(caught))
      await onRefresh()
    } finally {
      setBusy(false)
      lock.current = false
    }
  }
  async function deactivate() {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError("")
    try {
      await requestJson(`/api/memberships/${member.id}/deactivate`, {
        method: "POST",
      })
      toast.success(`${member.name} deactivated`)
      await onRefresh()
      setConfirm(false)
      close()
    } catch (caught) {
      setConfirm(false)
      setError(message(caught))
      await onRefresh()
    } finally {
      setBusy(false)
      lock.current = false
    }
  }
  return (
    <>
      <Sheet
        open
        onOpenChange={(value) => {
          if (!value) dismiss()
        }}
      >
        <SheetContent
          className="w-full gap-0 sm:max-w-lg"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            restoreFocus()
          }}
        >
          <SheetHeader className="border-b p-6 pr-12">
            <SheetTitle>Employee details</SheetTitle>
            <SheetDescription>
              {member.status === "deactivated"
                ? "This employee is inactive. Historical records are preserved."
                : editable
                  ? "Manage this employee’s profile and team access."
                  : "View this employee’s profile and team access."}
            </SheetDescription>
          </SheetHeader>
          <form onSubmit={save} className="flex min-h-0 flex-1 flex-col">
            <div className="flex-1 space-y-6 overflow-y-auto p-6">
              <Person member={member} self={self} />
              {member.status === "pending" && (
                <InvitationStatus member={member} />
              )}
              <fieldset disabled={!editable || busy} className="space-y-4">
                <Field label="Full name">
                  <Input
                    required
                    value={draft.name}
                    onChange={(e) =>
                      setDraft({ ...draft, name: e.target.value })
                    }
                  />
                </Field>
                <Field label="Phone">
                  <Input
                    type="tel"
                    value={draft.phone}
                    onChange={(e) =>
                      setDraft({ ...draft, phone: e.target.value })
                    }
                  />
                </Field>
                <Field label="Role">
                  <RoleSelect
                    value={draft.role}
                    actor={actor}
                    disabled={!editable || busy || lastSuper}
                    onChange={(role) => setDraft({ ...draft, role })}
                  />
                </Field>
                {lastSuper && (
                  <p className="text-xs text-muted-foreground">
                    Assign another Super Admin before changing this role.
                  </p>
                )}
                <Field label="Manager">
                  <ManagerSelect
                    value={draft.managerMembershipId}
                    members={members}
                    memberId={member.id}
                    disabled={!editable || busy}
                    onChange={(managerMembershipId) =>
                      setDraft({ ...draft, managerMembershipId })
                    }
                  />
                </Field>
                <Field label="Sender association">
                  <Input
                    value={draft.senderAssociation}
                    onChange={(e) =>
                      setDraft({ ...draft, senderAssociation: e.target.value })
                    }
                  />
                </Field>
              </fieldset>
              <div className="space-y-4 border-t pt-5">
                <Field label="Email address">
                  <Input value={member.email} readOnly />
                </Field>
                <div className="space-y-2">
                  <p className="text-sm font-medium">Application ID</p>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 break-all text-xs text-muted-foreground">
                      {member.applicationIdentifier}
                    </code>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label="Copy application ID"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(
                            member.applicationIdentifier
                          )
                          setCopied(true)
                          toast.success("Application ID copied")
                        } catch {
                          toast.error(
                            "Could not copy. Select the ID and copy it manually."
                          )
                        }
                      }}
                    >
                      {copied ? (
                        <Check className="size-4" />
                      ) : (
                        <Copy className="size-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </div>
              {canDeactivateMember(member, members, canManage, actor, self) && (
                <div className="space-y-3 border-t pt-5">
                  <h3 className="text-sm font-medium">Deactivate employee</h3>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Remove access and free their seat. Their historical deal
                    records will remain.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    className="text-destructive"
                    disabled={busy}
                    onClick={() => setConfirm(true)}
                  >
                    Deactivate employee
                  </Button>
                </div>
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t bg-background p-4">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={dismiss}
              >
                {editable ? "Cancel" : "Close"}
              </Button>
              {editable && (
                <Button type="submit" disabled={busy || !dirty}>
                  {busy && <LoaderCircle className="size-4 animate-spin" />}Save
                  changes
                </Button>
              )}
            </div>
          </form>
        </SheetContent>
      </Sheet>
      <Dialog
        open={confirm}
        onOpenChange={(value) => {
          if (!busy) setConfirm(value)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deactivate {member.name}?</DialogTitle>
            <DialogDescription>
              Their access will be removed immediately. Historical deal
              attribution stays intact. Unsaved profile changes will not be
              applied.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setConfirm(false)}
            >
              Keep employee
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void deactivate()}
            >
              {busy && <LoaderCircle className="size-4 animate-spin" />}
              Deactivate employee
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
