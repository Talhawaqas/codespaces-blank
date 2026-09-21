# Copyright Registration Plan

**Principle (per the SOW's own scope):** register what genuinely matters for enforcement and evidence; do not register every individual file. In Pakistan, copyright in software and original written works arises automatically on creation — registration with IPO-Pakistan's Copyright Office is not required for protection to exist, but it creates a stronger, dated public record that's far easier to rely on in a dispute or licensing negotiation.

## Priority 1 — Register These First

| Work | Why it's Priority 1 | Evidence already available |
|---|---|---|
| Core platform source code (as a compiled work, not file-by-file) — main monorepo | This is the commercial core of the business | Full git history, `github.com/Talhawaqas/codespaces-blank` |
| Custody SDK (`@inaya-network/custody-sdk`) | Published to a public npm registry — already publicly distributed, so establishing a dated copyright record matters more, not less | Full git history, `github.com/Talhawaqas/custody-sdk`, published npm versions |
| Whitepaper | Investor- and public-facing; commonly copied/quoted | Live at `/whitepaper`; recommend exporting a dated, versioned PDF snapshot specifically for the registration filing |
| Smart contract source (the `contracts/`, `aptos/`, `solana/`, `sui/` Solidity/Move/Anchor code as a compiled work) | Protocol-level code, high strategic value | Git history from 2026-08-03 onward |
| Logo / brand mark | Register as an artistic work in addition to pursuing trademark protection (Phase 4) — the two protections are complementary, not redundant | `inaya-network-dapp/public/inaya-logo.png` |

## Priority 2 — Register If Budget Allows

| Work | Reasoning |
|---|---|
| Business Workspace documentation set | Substantial original writing, but lower infringement risk than the code/brand itself |
| Fundraising documents (Company Profile, Ecosystem Overview/Architecture/Dev Deep-Dive) | Investor-facing, moderately sensitive, but versioned PDFs already carry their own dated `docId`/generation metadata as informal evidence |
| Mobile app source code | Separate repo, separate registration if the mobile app becomes commercially significant on its own |

## Deliberately Not Registering (per the SOW's own instruction)

- Individual source files, components, or routes — the compiled/collective work registrations above already cover these.
- Native desktop-wrapper code (`inaya-desktop`, `inaya-dapp-desktop`, drive helpers) as separate works — these are derivative/supporting works of the core platform; note their existence in the core registration's description rather than filing separately, unless counsel advises otherwise for the GPL-isolation strategy noted in the IP Asset Register.
- Internal-only documentation, working notes, or superseded SOW files.

## What Registration Actually Requires (for planning purposes only — confirm exact current requirements with IPO-Pakistan or counsel)

Typically: a completed application form, a representative copy/sample of the work (for software, often source code excerpts or a deposit copy per IPO-Pakistan's current practice), proof of authorship/ownership (this is exactly what the IP Asset Register and the signed assignment agreements are for), and the applicable fee. **This plan does not confirm current fees, forms, or turnaround times — those change and must be verified directly with IPO-Pakistan or counsel at filing time.**

## Sequencing

1. Finalize and sign the Founder and Contributor IP Assignment Agreements first — a registration filed before ownership is legally clean creates a paper trail that contradicts itself.
2. File Priority 1 items.
3. Revisit Priority 2 based on budget and actual commercial pressure (e.g., a specific infringement concern, an investor due-diligence request).
