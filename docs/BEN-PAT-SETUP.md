# Connecting sync: the one thing only Ben can do (about 3 minutes)

Magpie syncs through a private repository of yours. It needs a **fine-grained personal
access token** that can touch ONLY that repository. Tokens can only be minted on GitHub's
website while signed in as you.

0. Create the private repository first if it does not exist yet (any name; `magpie-data` is
   what Settings prefills). It can stay empty; the first sync writes every file.
1. GitHub → your avatar → **Settings** → **Developer settings** (bottom of the left sidebar)
   → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. Name: `magpie sync` (anything works).
3. Expiration: your call. "No expiration" means never re-pasting; a dated one is safer if
   the account matters at work (Settings shows a clear error when it lapses).
4. **Repository access**: "Only select repositories" → pick the data repository ONLY.
5. **Permissions → Repository permissions → Contents → Read and write.** Nothing else.
6. Generate, **copy the `github_pat_…` string** (shown exactly once).

Then on EACH machine:

7. Open Magpie → **Settings** → Sync → owner, repository, paste the token → **Connect and
   sync**. The token is stored only on that device and never synced or backed up.

From then on every change commits to the data repository within a few seconds, and a new
or wiped machine rebuilds itself from a token paste. The repository's commit history is a
point-in-time backup of the whole budget. Never make that repository public.
