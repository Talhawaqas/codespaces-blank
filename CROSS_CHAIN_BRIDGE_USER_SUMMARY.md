# $INAYA can now move between chains — and you can stake it from any of them

You're no longer stuck holding $INAYA only on BNB Chain. It can now travel to Ethereum, Polygon, and Avalanche (testnets for now), and you can stake it — earn rewards, unstake, claim — no matter which of those chains it's currently sitting on. It's still the same $INAYA everywhere; there's no second token to keep track of.

## How it works, in plain terms

- **Bridging**: send $INAYA from BNB Chain to Ethereum, Polygon, or Avalanche (or back), and it shows up on the other side as the same $INAYA, same balance, just on a different network.
- **One staking position, no matter where your tokens are.** If you stake from Ethereum today and from BNB Chain next week, that's not two separate stakes — it's one combined position, one reward balance. You can see a breakdown of which network each part originally came from, just for your own reference.
- **Nothing about the staking deal changes.** Same three options as before — Flexible, 30-day, 90-day — same reward multipliers. Bridging doesn't add a new tier or change the math.
- **Unstake or claim rewards to whichever chain you want.** You don't have to unstake back to the chain you started from.
- **A relayer covers the gas** for completing transfers on the receiving chain during this testnet phase, so you're never stuck holding tokens on a network where you have no gas to move them.

## Security, in plain terms

- Moving tokens between chains always needs multiple independent validators to agree before anything is credited — no single key can move funds on its own.
- A message can never be processed twice — replay attempts are rejected automatically.
- If something ever needs to be paused for safety, only the cross-chain part pauses. Regular same-chain staking and transfers keep working the whole time.

## We're on testnet — this is an early release

Everything above runs on BNB Chain Testnet, Ethereum Sepolia, Polygon Amoy, and Avalanche Fuji — test networks, not real money. This is a real, working system being proven out before any live deployment. A Solana version is built and ready for review, but hasn't been tested live yet, so it's not available to use quite yet.

## What's not here yet

- Solana isn't live yet — the groundwork is built, but it needs a dedicated testing pass before it's turned on.
- The mobile app supports bridging and viewing your combined position, but staking directly from another chain is web-only for now — it's a multi-step action that doesn't fit a phone screen well yet.
- This hasn't been deployed to the public testnets yet — that's the next step, and it needs test funds in a few wallets first (see the funding guide).
