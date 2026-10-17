// Shared loader for the contact sub-routes: same rule as GET /crm/contacts/:id
// (org member with access to the contact's department).
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../../lib/orgs.js";

export async function loadContact(req, orgId, contactId) {
  if (!orgId) return { error: "orgId is required.", status: 400 };
  if (!ObjectId.isValid(String(contactId))) return { error: "Contact not found.", status: 404 };
  await ensureOrgIndexes();
  const auth = await requireMembership(req, orgId);
  if (auth.error) return { error: auth.error, status: auth.status };
  const { crmContacts } = await getOrgCollections();
  const contact = await crmContacts.findOne({ _id: toObjectId(contactId), orgId: toObjectId(orgId), deletedAt: null });
  if (!contact || !canAccessDepartment(auth.membership, contact.departmentId)) return { error: "Contact not found.", status: 404 };
  return { auth, contact };
}

export function serializeActivity(a) {
  return {
    id: a._id.toString(), type: a.type, subject: a.subject, body: a.body, at: a.at,
    durationMinutes: a.durationMinutes ?? null, location: a.location || null, attendees: a.attendees || [],
    delivery: a.delivery || null, deliveryReason: a.deliveryReason || null, hasInvite: !!a.ics,
    createdByEmail: a.createdByEmail, createdAt: a.createdAt,
  };
}
