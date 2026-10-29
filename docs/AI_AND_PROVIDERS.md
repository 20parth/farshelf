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

Farshelf has no central server or shared OAuth app, so you create your own client. It
takes about five minutes and costs nothing.

1. Open https://console.cloud.google.com/ and create a project.
2. **APIs & Services › Library:** enable **Google Drive API**.
3. **OAuth consent screen:** set user type _External_, fill in the app name and your
   email, and add scopes `openid`, `email` and `.../auth/drive.file`. While the app is
   in _Testing_, add your Google account as a test user.
4. **Credentials › Create credentials › OAuth client ID:** application type **Desktop
   app**. Copy the client ID and client secret. For installed apps Google treats this
   secret as non-confidential, and Farshelf also uses PKCE.
5. In Farshelf: Add storage › Google Drive, paste both, then click **Sign in with
   Google**. Approve in the new tab, come back, and click **Add storage**.

Farshelf creates a folder (default name `Farshelf`) in your Drive and can only see
files it created, because it uses the `drive.file` scope. The refresh token goes in
your keychain. Revoke access any time at https://myaccount.google.com/permissions.

Limits are Google's: 750 GB of uploads per day per account, and your plan's quota.
While your OAuth app is in Testing mode, Google may expire refresh tokens after 7
days. Publishing the app (no verification needed for personal use of `drive.file`)
avoids this.

## WebDAV / Nextcloud

Use the WebDAV URL from Nextcloud › Files › Settings, e.g.
`https://cloud.example.com/remote.php/dav/files/USERNAME/`, with an **app password**
(Nextcloud › Personal settings › Security).
