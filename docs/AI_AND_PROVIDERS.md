# AI and storage providers

## AI

AI is optional and off by default. Everything else in Farshelf works without it.

### Local with Ollama (recommended)

```bash
# install from https://ollama.com, then:
ollama pull llama3.2
ollama serve        # if it is not already running
```

In Farshelf: Settings › AI › enable, keep provider **Ollama** and the URL
`http://127.0.0.1:11434`, then click **Test connection**. Requests stay on your
computer. A 3B model needs about 4 GB of RAM. Larger models give better plans.

### OpenAI-compatible endpoints

Choose **OpenAI-compatible API** and set the base URL (the part before
`/chat/completions`):

| Server           | Base URL                                                        |
| ---------------- | --------------------------------------------------------------- |
| LM Studio        | `http://127.0.0.1:1234/v1`                                      |
| llama.cpp server | `http://127.0.0.1:8080/v1`                                      |
| vLLM             | `http://127.0.0.1:8000/v1`                                      |
| Hosted APIs      | the provider's documented URL, e.g. `https://api.openai.com/v1` |

Hosted providers bill you for inference under their own pricing. Farshelf has no
hosted model and gets nothing from your usage. The API key is stored in your OS
keychain when available.

### What the features do

- **Find files (Ask AI › Find files):** sends only your question. The model returns a
  JSON filter (category, size, dates, name words), which is validated and run against
  the local index.
- **Plan changes in this folder:** sends your request and the current folder path.
  Names, sizes and dates of items in that folder are sent only if you tick _share
  names_, and never for encrypted storage. The model may only propose `mkdir`, `move`
  and `trash`. You approve each step, approved steps run through the normal API, and
  the activity log marks them “AI plan, approved”.

Invalid or unsafe model output is rejected with a message, never partly run.

## Google Drive

### For end users

If your copy of Farshelf includes a built-in Google sign-in (set up once by whoever
built it, as described below), adding Google Drive is:

1. **Add storage › Google Drive** (preselected).
2. Click **Sign in with Google**, choose your account and click **Allow**.

That's it. Farshelf adds the storage on its own, creates a `Farshelf` folder in your
Drive, and can only see files inside that folder (`drive.file` scope). Revoke access
any time at https://myaccount.google.com/permissions.

### For publishers: set up the built-in sign-in once

Whoever distributes Farshelf (the maintainer, or anyone shipping their own build) does
this **once**. End users never see it.

1. In https://console.cloud.google.com/ create a project, and enable the **Google
   Drive API** under APIs & Services › Library.
2. **OAuth consent screen / Google Auth Platform:**
   - App name `Farshelf`, plus a support email, logo and homepage. The homepage can be
     the GitHub repository.
   - A **privacy policy URL**.
   - Data access: add only `openid`, `email` and `.../auth/drive.file`.
3. **Credentials › Create credentials › OAuth client ID › Desktop app.** Desktop
   clients accept the loopback redirect Farshelf uses (`http://127.0.0.1:<port>/oauth/callback`)
   on any port, so no redirect URI needs configuring.
4. **Publish the app:** Audience › _Publish app_ (move it from _Testing_ to _In
   production_). In Testing mode only listed test users can sign in, and their sign-in
   expires after 7 days.
5. `drive.file` is a non-sensitive scope, so Google requires no security assessment.
   Submit **brand verification** (usually a few business days) so the consent screen
   shows your app name and logo. That needs the homepage and privacy policy on a domain
   you have verified in Google Search Console.
6. Give the client to Farshelf on the machines and builds where it should be built in:
   - **Your Mac or server:** create `google-oauth.json` in the Farshelf folder (see
     `google-oauth.example.json`). The macOS app build (`npm run package:mac`) copies it
     into `Farshelf.app`. It is git-ignored.
   - **Environment:** set `FARSHELF_GDRIVE_CLIENT_ID` / `FARSHELF_GDRIVE_CLIENT_SECRET`.

**Public releases never contain the client secret.** Google documents desktop-client
secrets as not confidential, and Farshelf uses PKCE, so a leaked secret cannot reach
anyone's files. It could, however, let someone else build an app that shows up as
yours on Google's consent screen. So the project's public builds leave it out, and
people who download them use **Advanced** with their own client. If you distribute a
`Farshelf.app` you built with your `google-oauth.json` inside, you are choosing to share
that secret with everyone who gets the app.

### Using your own client (advanced)

Anyone can use a personal client instead, for example when a build has no built-in
sign-in. Follow steps 1–3 above (in Testing mode, add yourself as a test user). Then
in Farshelf open **Advanced** under Google Drive and paste the client ID and secret.
A client typed there always takes priority over the built-in one.

Limits are Google's: 750 GB of uploads per day per account, and your plan's quota.

## WebDAV / Nextcloud

Use the WebDAV URL from Nextcloud › Files › Settings, e.g.
`https://cloud.example.com/remote.php/dav/files/USERNAME/`, with an **app password**
(Nextcloud › Personal settings › Security).
