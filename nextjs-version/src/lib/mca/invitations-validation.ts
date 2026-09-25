import { ROLES, type Role } from "./types"

export const INVITATION_MESSAGES = {
  name: "Enter the employee's full name.",
  nameMax: "Use at most 120 characters.",
  email: "Enter a valid email address.",
  phone: "Enter a phone number with 7 to 32 characters.",
  role: "Choose a valid role.",
  senderAssociation: "Use at most 160 characters.",
  clientName: "Enter the business name.",
  clientNameMax: "Use at most 150 characters.",
  clientEmailMax: "Use at most 254 characters.",
} as const

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function add(errors: Record<string, string[]>, field: string, message: string) {
  errors[field] = [...(errors[field] ?? []), message]
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

export function validateTeamInvitation(input: {
  name?: unknown
  email?: unknown
  phone?: unknown
  role?: unknown
  senderAssociation?: unknown
}): Record<string, string[]> {
  const errors: Record<string, string[]> = {}
  const name = text(input.name)
  if (!name) add(errors, "name", INVITATION_MESSAGES.name)
  else if (name.length > 120) add(errors, "name", INVITATION_MESSAGES.nameMax)

  const email = text(input.email)
  if (!email || !EMAIL.test(email)) add(errors, "email", INVITATION_MESSAGES.email)

  const phone = text(input.phone)
  if (phone && (phone.length < 7 || phone.length > 32)) add(errors, "phone", INVITATION_MESSAGES.phone)

  if (input.role !== undefined && !ROLES.includes(input.role as Role)) add(errors, "role", INVITATION_MESSAGES.role)

  const sender = text(input.senderAssociation)
  if (sender.length > 160) add(errors, "senderAssociation", INVITATION_MESSAGES.senderAssociation)
  return errors
}

export function normalizeTeamInvitationInput(input: {
  name?: unknown
  email?: unknown
  phone?: unknown
  role?: unknown
  managerMembershipId?: unknown
  senderAssociation?: unknown
}) {
  const phone = text(input.phone)
  const sender = text(input.senderAssociation)
  const manager = typeof input.managerMembershipId === "string" ? input.managerMembershipId.trim() : ""
  return {
    name: text(input.name),
    email: text(input.email),
    phone: phone || undefined,
    role: input.role,
    managerMembershipId: manager || undefined,
    senderAssociation: sender || undefined,
  }
}

export function validateApplicationInvitation(input: {
  clientName?: unknown
  email?: unknown
}): Record<string, string[]> {
  const errors: Record<string, string[]> = {}
  const clientName = text(input.clientName)
  if (!clientName) add(errors, "clientName", INVITATION_MESSAGES.clientName)
  else if (clientName.length > 150) add(errors, "clientName", INVITATION_MESSAGES.clientNameMax)

  const email = text(input.email)
  if (!email || !EMAIL.test(email)) add(errors, "email", INVITATION_MESSAGES.email)
  else if (email.length > 254) add(errors, "email", INVITATION_MESSAGES.clientEmailMax)
  return errors
}
