// scripts/gmail-refresh-token.mjs
//
// One-time helper: obtains a Gmail REFRESH TOKEN for the mailbox that will send Inaya workflow emails.
//
//   node scripts/gmail-refresh-token.mjs
//
// You need an OAuth client of type "Desktop app" (Google Cloud console -> Credentials -> Create credentials ->
// OAuth client ID -> Desktop app). This script starts a listener on 127.0.0.1 (nothing is exposed to the network),
// prints a Google sign-in link, waits for you to sign in as the SENDING mailbox and click Allow, exchanges the code
// (with PKCE), and prints the refresh token to this terminal only. It writes nothing to disk and sends the values
// nowhere except to Google. Paste the three values (client ID, client secret, refresh token) into
// Inaya -> Automations -> Credentials -> "Gmail (OAuth refresh token)".
//
// Optional: set GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET in the environment to skip the prompts.

import http from "node:http";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import readline from "node:readline/promises";

const SCOPE = "https://www.googleapis.com/auth/gmail.send";
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q) => (await rl.question(q)).trim();

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || (await ask("OAuth client ID: "));
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || (await ask("OAuth client secret: "));
rl.close();
if (!clientId || !clientSecret) { console.error("Both the client ID and the client secret are required."); process.exit(1); }

const b64url = (buf) => buf.toString("base64url");
const verifier = b64url(crypto.randomBytes(32));
const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
const state = b64url(crypto.randomBytes(16));

const server = http.createServer();
await new Promise((res) => server.listen(0, "127.0.0.1", res));
const redirectUri = `http://127.0.0.1:${server.address().port}`;

const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
  client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: SCOPE,
  access_type: "offline", prompt: "consent", code_challenge: challenge, code_challenge_method: "S256", state,
}).toString();

console.log("\nOpen this link, sign in as the mailbox that will SEND the alerts, and click Allow:\n");
console.log(authUrl + "\n");
if (process.platform === "win32") exec(`start "" "${authUrl}"`);
else if (process.platform === "darwin") exec(`open "${authUrl}"`);
else exec(`xdg-open "${authUrl}"`);

const code = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Timed out after 5 minutes waiting for the sign-in.")), 5 * 60 * 1000);
  server.on("request", (req, res) => {
    const u = new URL(req.url, redirectUri);
    if (u.pathname !== "/") { res.writeHead(404).end(); return; }
    const err = u.searchParams.get("error");
    if (err) { res.writeHead(400, { "content-type": "text/plain" }).end(`Google returned an error: ${err}`); clearTimeout(timer); reject(new Error(`Google returned: ${err}`)); return; }
    if (u.searchParams.get("state") !== state) { res.writeHead(400, { "content-type": "text/plain" }).end("State mismatch."); return; }
    res.writeHead(200, { "content-type": "text/plain" }).end("Done. You can close this window and return to the terminal.");
    clearTimeout(timer);
    resolve(u.searchParams.get("code"));
  });
}).finally(() => server.close());

const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier }).toString(),
});
const tokens = await tokenRes.json().catch(() => ({}));
if (!tokenRes.ok) { console.error("Google refused the code exchange:", tokens.error_description || tokens.error || tokenRes.status); process.exit(1); }
if (!tokens.refresh_token) {
  console.error("Google did not return a refresh token. Remove this app's access at https://myaccount.google.com/permissions and run the script again.");
  process.exit(1);
}
console.log("\nSuccess. Store these three values in Inaya (Automations -> Credentials -> Gmail):\n");
console.log("  Client ID:      ", clientId);
console.log("  Client secret:  ", clientSecret);
console.log("  Refresh token:  ", tokens.refresh_token);
console.log("\nKeep them private. Emails will be sent from the mailbox you just signed in with.");
process.exit(0);
