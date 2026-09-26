"use client";

import { api } from "../nas/ui";

export const q = (orgId, extra = "") => `orgId=${encodeURIComponent(orgId)}${extra}`;
export const post = (orgId, path, body = {}, method = "POST") => api(`/api/orgs/support/${path}`, { method, body: JSON.stringify({ orgId, ...body }) });
export const get = (orgId, path, extra = "") => api(`/api/orgs/support/${path}?${q(orgId, extra)}`);
