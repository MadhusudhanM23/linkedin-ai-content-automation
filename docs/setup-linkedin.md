# Setup 3 of 3 — LinkedIn developer app and OAuth

The slowest step. Product access is granted by LinkedIn, and approval can take
anywhere from minutes to about a week.

Verified against the
[Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api)
and [Images API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api)
docs on 3 October 2026.

## 1. Create the app

1. Open **https://www.linkedin.com/developers/apps** → **Create app**.
2. You must attach a **LinkedIn Page**. If you do not have one, create a simple
   company page first — LinkedIn requires it even for personal posting.
3. Upload a logo, accept the terms, create.
4. **Settings** tab → **Verify** the app from your Page. The app stays
   unusable until verification completes.

## 2. Request the products

**Products** tab → request both:

| Product | Why |
|---|---|
| **Share on LinkedIn** | Grants `w_member_social` — permission to post. |
| **Sign In with LinkedIn using OpenID Connect** | Grants `openid` + `profile`, needed for `/v2/userinfo` to resolve your person URN. |

Both are usually self-serve. Wait until each shows as granted — the API returns
403 until then.

Do **not** request Marketing Developer Platform; this workflow posts as a
member, not as an organization.

## 3. Redirect URL

**Auth** tab → **Authorized redirect URLs for your app** → add exactly:

```
http://localhost:5678/rest/oauth2-credential/callback
```

Must match character for character, including the port. If you changed
`N8N_PORT`, use that port instead.

Copy the **Client ID** and **Client Secret** from the same tab.

## 4. Put them in `.env`

```
LINKEDIN_CLIENT_ID=your client id
LINKEDIN_CLIENT_SECRET=your client secret
LINKEDIN_API_VERSION=202609
```

```bash
docker compose up -d
```

## 5. Connect the credential in n8n

1. **http://localhost:5678** → **Credentials** → **Add credential** →
   **LinkedIn OAuth2 API**.
2. Enter the Client ID and Secret.
3. Set **Scope** to:
   ```
   openid profile w_member_social
   ```
4. **Sign in with LinkedIn** → authorize → **Save**.
5. Open the workflow and assign this credential to the four LinkedIn nodes:
   **LinkedIn Me**, **Init Image Upload**, **Upload Image Binary**,
   **Create LinkedIn Post**.

## 6. Verify

```bash
npm run doctor
```

To test the token standalone, put it in `.env` as `LINKEDIN_ACCESS_TOKEN`
temporarily — `doctor` will print your person URN. Remove it afterwards; the
workflow gets its token from the n8n credential, not from `.env`.

## What the workflow actually calls

```
GET  /v2/userinfo                            -> sub, becomes urn:li:person:{sub}
POST /rest/images?action=initializeUpload    -> value.uploadUrl, value.image
PUT  {uploadUrl}                             -> the PNG bytes
POST /rest/posts                             -> 201 + x-restli-id header
```

Headers on every `/rest/` call:

```
Authorization: Bearer {token}
LinkedIn-Version: 202609
X-Restli-Protocol-Version: 2.0.0
```

Post body:

```json
{
  "author": "urn:li:person:xxxx",
  "commentary": "the post text",
  "visibility": "PUBLIC",
  "distribution": {
    "feedDistribution": "MAIN_FEED",
    "targetEntities": [],
    "thirdPartyDistributionChannels": []
  },
  "content": { "media": { "id": "urn:li:image:xxxx", "altText": "..." } },
  "lifecycleState": "PUBLISHED",
  "isReshareDisabledByAuthor": false
}
```

**Only a 2xx carrying `x-restli-id` counts as published.** An HTTP node that
merely ran without throwing proves nothing, and the workflow does not treat it
as proof.

## Keep the API version current

LinkedIn retires versions on a rolling schedule — `202510` sunsets on
15 October 2026. The version is **not** hard-coded: bump
`LINKEDIN_API_VERSION` in `.env` and restart. Check the docs every few months.

## Token expiry

LinkedIn member access tokens last about 60 days. Refresh tokens are not
available to every app tier. If posting starts failing with 401 after a couple
of months, re-authorize the credential in n8n — that is normal, not a bug.

Set a calendar reminder for ~55 days after you authorize.

## Troubleshooting

| Error | Cause |
|---|---|
| 403 `ACCESS_DENIED` | Products not granted yet, or scope missing `w_member_social`. |
| 401 `EMPTY_ACCESS_TOKEN` | Credential not assigned to the node, or token expired. |
| `redirect_uri does not match` | The Auth tab URL differs from n8n's callback. Must be exact. |
| 403 on image upload | The image `owner` URN does not match the authenticated member. |
| 400 `FIELD_LENGTH_TOO_LONG` | Commentary over 3,000 chars. The validator catches this first. |
| 422 `UNPROCESSABLE_ENTITY` | Usually a malformed image URN in `content.media.id`. |

Never work around an auth failure with browser automation or stored cookies.
That violates LinkedIn's terms and the spec's cost and safety rules — fix the
app permissions instead.
