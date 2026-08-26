# Applying the CLA — OSS web repo

For `github.com/Priyanshu-1622/skiff`. Six files.

**Not interchangeable with the desktop drop.** That one refers to
`packages/core`, `apps/desktop` and the Apache/AGPL split, none of which exist
here.

## Files

| File | New or replaced |
| --- | --- |
| `CLA.md` | new — individual agreement |
| `CLA-CORPORATE.md` | new — for companies |
| `CONTRIBUTING.md` | replaced — original text kept, License section rewritten |
| `.github/workflows/cla.yml` | new |
| `.github/pull_request_template.md` | replaced (two checklist lines added) |
| `APPLY-CLA.md` | this file — delete after |

No `package.json` edits. Those licence fields were fixed in the earlier
licensing drop.

---

## Setup, in order

### 1. Signatures branch

The bot records signatures on its own branch, so it never touches `main`.

```bash
git checkout --orphan cla-signatures
git rm -rf .
mkdir signatures
echo '{"signedContributors":[]}' > signatures/cla.json
git add signatures/cla.json
git commit -m "Initialise CLA signature store"
git push origin cla-signatures
git checkout main
```

`--orphan` makes a branch with no history, so no code ends up on it.

### 2. Token

The built-in Actions token can't write to that branch.

1. GitHub → Settings → Developer settings → **Personal access tokens** →
   **Fine-grained tokens** → Generate new token
2. Repository access: **Only select repositories** → `skiff` (add `skiff-app`
   too if you want one token for both)
3. Permissions → Repository permissions → **Contents: Read and write**
4. **Put the expiry date in your calendar.** When it expires the CLA check
   starts failing and the error doesn't say why

### 3. Secret

Repo → Settings → Secrets and variables → Actions → New repository secret

- Name: `CLA_SIGNATURES_TOKEN`
- Value: the token

Each repository needs its own secret, even if the token is the same.

### 4. Branch protection — do not skip this

This is the step that actually makes the CLA hold. Without it, the bot can post
its comment and you can merge anyway, and nothing stops you — which is exactly
what happens at 1am when someone sends a good fix and the check is amber.

Repo → Settings → Branches → Add branch protection rule for `main`:

- **Require status checks to pass before merging** → tick
- Add **`CLA / Signed`** and **`DCO / Signed-off-by`** as required checks
  (they only appear in the list after each has run once, so open a test PR
  first if they're missing)
- **Do not** tick "Allow administrators to bypass" unless you have a reason

An unsigned merge is not recoverable by policy afterwards. You'd have to ask
that person individually, which is the whole thing you're trying to avoid.

### 5. Test it once

You're in the allowlist, so the bot won't prompt you.

1. Temporarily remove `Priyanshu-1622` from the `allowlist:` line in `cla.yml`
2. Open a throwaway PR against your own repo
3. Check the bot comments, reply with the sentence, check the status goes green
4. Check `signatures/cla.json` on the `cla-signatures` branch has your name
5. Put yourself back in the allowlist

A CLA bot that silently isn't running is the same as no CLA, and you find out
when someone contributes.

---

## Keeping the record

The signatures are your evidence. Treat them that way.

- **The `cla-signatures` branch is the record.** If you ever delete or
  transfer the repo, that branch goes with it. Back it up somewhere else — a
  private repo, or just a copy of `cla.json` in your own files, refreshed
  occasionally.
- **Don't rewrite history on that branch.** Force-pushing it destroys the audit
  trail of when people signed.
- **Keep the PR threads.** The bot's comment and the contributor's reply, with
  timestamps, are stronger evidence than the JSON file alone. Don't delete
  comments on merged PRs.
- **If someone signs by email** (corporate CLA), save the signed PDF and the
  email it arrived in, not just the PDF.

---

## About your existing contributor

The CLA does not apply backwards to people who never signed it. Your one
existing contributor's change to `apps/api/src/routes/auth.ts` stays AGPL-only
and can't go into a commercial edition.

No action needed — nothing from that file is in the desktop app or the engine.
But it's the reason to get this in place **before** the launch brings more
contributors, not after.

If you ever do want that specific code commercially, the only route is to ask
them directly and keep the written reply. A GitHub comment is enough.

---

## What was hardened in v1.1

Compared with the first draft, the agreement now also covers:

- **Explicit commercial/closed-source language** in section 2, so no contributor
  can later claim they didn't understand what they were granting. Ambiguity is
  what gets litigated
- **Moral rights** (section 4) — India's Copyright Act section 57 gives authors
  rights that survive a copyright licence. Without a non-assertion clause a
  contributor could object to how their code was modified
- **Electronic acceptance** (section 15) — states that a PR comment is intended
  as a signature and is admissible, and that the contributor won't contest it
  on that basis. This was the weakest point in the first draft
- **Assignment** (section 13) — so incorporating a company later, or selling the
  project, doesn't require re-collecting every signature
- **Prior contributions** (section 8) — signing covers a contributor's earlier
  PRs too, not just future ones
- **Employer rights** (section 5c) plus the separate Corporate CLA. This is the
  most common real-world dispute in open source and the first draft handled it
  in one sentence
- **AI-assisted code** (section 5g) — increasingly relevant, and absent from
  most older CLAs
- **Malicious code** (section 5f) — not standard, but Skiff holds SSH keys
- **Survival, severability, entire agreement** (sections 16–17) — the boring
  clauses that stop one bad sentence taking the whole document down
- **A commitment back to contributors** (section 10) — the open-source edition
  stays open source. This costs you nothing commercially and materially
  increases the number of people willing to sign

---

## The honest limit

This is now a solid, conventional agreement — the same shape commercial
open-source companies use, with the India-specific gaps filled. It is
substantially better than most projects have.

It is still not a substitute for a lawyer, and I'm not one. Two specific things
worth a professional hour before you sell the first enterprise licence:

1. **Whether you sell as an individual or a company.** Selling software
   personally in India exposes your personal assets and complicates GST and
   income tax. Most people incorporate before the first sale. Section 13 is
   written so that incorporating later doesn't break the CLAs, but the
   incorporation itself is the thing to get advice on
2. **The moral rights waiver in section 4.** Waiver of section 57 rights is
   accepted practice in India but not as settled as in some jurisdictions. The
   clause is drafted as a non-assertion covenant for that reason, which is the
   safer form, but it's worth confirming

Neither is urgent today. Both are cheap to sort out before revenue and expensive
to sort out after.
