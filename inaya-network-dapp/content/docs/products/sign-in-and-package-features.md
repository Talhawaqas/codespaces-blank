---
slug: sign-in-and-package-features
title: "Passkeys, Company SSO, Custom Domains and What Each Package Includes"
description: "Sign in with a passkey, set up single sign-on for your staff (Enterprise), serve your workspace on your own domain (Business and Enterprise), see which features each Inaya Business OS package includes, and the support response times for each package."
product: Business Workspace
category: guide
contentType: Product Guide
audience: [business-admin, security, it-admin]
status: live
version: current
tags: [passkey, webauthn, face id, fingerprint, sso, single sign-on, oidc, microsoft entra, okta, google workspace, custom domain, packages, plans, pricing, priority support, sla, onboarding]
lastVerifiedAt: "2026-11-26"
relatedDocs: [business-workspace, customer-portal, identity-integration]
---

## Passkeys (every package)

A passkey lets you sign in with your fingerprint, your face or your device PIN instead of an email link. It works only on the Inaya website it was made for, so a fake website cannot trick you into using it.

**Add a passkey**: sign in, open **Security**, enter a name such as "Work laptop" and choose **Add a passkey**. Your device asks for your fingerprint, face or PIN.

**Sign in with it**: on the sign-in screen choose **Sign in with a passkey**. You don't need to type your email.

- A passkey is for you as a person, so it signs you into every company you belong to.
- It already counts as two-step verification, so you are not asked for an authenticator code as well.
- You can add up to 10 passkeys and remove any of them in **Security**.
- A passkey made on www.inayanetwork.com does not work on your company's custom domain. Add a separate one there.

## Company single sign-on (SSO): Enterprise

Your staff sign in with your company's own identity provider. Microsoft Entra ID, Google Workspace, Okta, Auth0, Keycloak and any other OpenID Connect provider work.

1. In your identity provider, create a **web application** and register the redirect URI shown in **Settings > Single sign-on (SSO)**.
2. In Inaya, enter the **issuer URL**, the **client ID**, the **client secret** and your staff **email domains** (for example example.com).
3. Choose **Test the provider**, then switch **SSO is on** and save. Inaya won't switch SSO on until your provider answers, so a wrong address can't lock anyone out.
4. Optional: turn on **Require SSO for these domains**. Email links and Google sign-in then stop working for those email addresses. Passkeys keep working.

Staff choose **Sign in with company SSO** on the sign-in screen and enter their work email.

SSO only proves who someone is. That person still has to be invited to your company. If they have a pending invitation, signing in with SSO accepts it. Public email domains such as gmail.com can't be claimed, and each domain can belong to only one company.

The client secret is stored encrypted and is never shown again after you save it.

## Custom domain: Business and Enterprise

You can serve your company's sign-in and workspace on your own address, for example **files.example.com**.

1. In **Settings > Branding**, enter the domain.
2. At your DNS provider, add the **TXT** record shown, which proves you own the domain. Also add a **CNAME** record pointing the domain to **cname.vercel-dns.com**.
3. Choose **Check**. Once Inaya confirms you own the domain, it connects the domain to its hosting, and the security certificate is issued automatically. The status changes from **Attached** to **Live**.

On a live custom domain, the sign-in screen shows your logo and company name.

## What each package includes

| Feature | Starter | Professional | Business | Enterprise |
|---|---|---|---|---|
| Client-side encryption, passkeys, secure sharing, version history, basic AI assistant | Yes | Yes | Yes | Yes |
| Advanced file sharing, team folders (departments and projects), role-based permissions, advanced activity logs, AI document assistant | | Yes | Yes | Yes |
| Advanced admin dashboard, organization-wide policies, advanced audit logs, device and session management, secure client portals, custom domain, advanced AI assistant (prepares actions for your approval), appointments, email campaigns, API access | | | Yes | Yes |
| Single sign-on, custom retention policies, compliance readiness (NIST controls and evidence), customer-managed encryption keys, government security profile, dedicated onboarding | | | | Yes |

## Add-ons for Professional

On Professional you can add Business features one at a time. Choose them when you request your package, or later in **Settings > Billing > Add-ons**.

| Add-on | USD per month | PKR per month |
|---|---|---|
| Appointment booking & team calendars | $15 | PKR 3,000 |
| Email campaigns (10,000 emails a month) | $15 | PKR 3,000 |
| Inaya Connect (WhatsApp Business & AI) | $35 | PKR 6,000 |
| Secure client portal | $15 | PKR 3,000 |
| Custom domain | $10 | PKR 2,000 |
| API access | $15 | PKR 3,000 |
| Extra storage, per TB (up to 4 TB) | $30 | PKR 7,500 |

A year costs 10 months. Add-ons are not discounted in the Pakistan pilot. If you choose several, the form shows when Business costs less, since it includes them all plus 5 TB, 10 users and the admin features. If you move to Business or Enterprise, the add-ons end because the package already includes them.

If your package doesn't include a feature, Inaya tells you which package does. Companies that were already on a smaller package on 26 November 2026 keep what they were using.

## Support response times

These are times to the **first reply** from the Inaya support team. Support works Monday to Saturday, 10:00 to 19:00 Pakistan time.

| Package | First reply |
|---|---|
| Starter | within 48 hours |
| Professional, Business | within 24 hours (priority) |
| Enterprise | within 8 hours, plus a named onboarding contact |

Inaya's support desk recognises your package from your email address automatically. Enterprise requests are raised to high priority. When a company moves to Enterprise, an onboarding request opens for its owner straight away.
