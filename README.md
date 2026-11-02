# Anything

Anonymous feedback and polls for a known group at IITGN. The organiser lists who can respond.
Each person gets one ballot and can use it once, and the stored response does not say who sent it.

For who it is for and what it promises, see [SPEC.md](SPEC.md).

**Live app:** TODO, add the deployed link.

## Run it

You need Node.js 20.12 or newer.

```sh
npm install && npm start
```

Open http://localhost:3000. Data is kept in `./data`, and you do not need to install a database.

## Test it

```sh
npm install && npm test
```

This runs 23 tests, with no browser or database to install. Every statement in SPEC.md has a
test, and one test fails if a statement loses its test.

The browser tests for phone use, blinding and plain-text display (S12, S21, S23) run with:

```sh
npx playwright install chromium
npm run test:e2e
```

To run the API tests on real Postgres, set `TEST_DATABASE_URL`. GitHub Actions does this on every pull request.

## Deploy it

1. On [Render](https://render.com), choose **New > Blueprint** and select this repo.
2. Accept the plan in `render.yaml`. It creates the web service and a Postgres database, and links them.
3. When the deploy finishes, open the `onrender.com` link and add it to this README.

Things to know about the free plan:

- The app sleeps after 15 minutes idle, so the first visit afterwards can take about a minute.
  Open the link yourself before a demo.
- The free database expires 30 days after creation. To keep it longer, make a free database on
  [Neon](https://neon.tech), then set its URL as `DATABASE_URL`.
- Never run production without `DATABASE_URL`. The local fallback is lost on each restart.

## How the anonymity works

1. The participant's browser makes a random token and hides it with a random blinding number.
2. The server checks the invite, marks it as used, and signs the hidden value with the form's key.
3. The browser removes the blinding, which leaves a valid signature the server has never seen.
4. The participant sends the token, the signature and their answers. The server checks the
   signature, records the token as spent and stores the answers in a separate table.

The invite and the ballot are linked only by the blinding number, which never leaves the browser.
The code is in `public/blind.js`, and the page and the server share it.

## What it does not protect against

- **Written answers** can identify someone through what they say. The ballot page warns about this.
- **Very small groups**: results stay hidden below 3 responses, but with 3 people there is little
  to hide in. After that, an organiser refreshing often could compare results before and after
  one new response, and could line that up with who just collected a ballot.
- **The hosting logs**: the host can record IP addresses and request times. This app stores neither,
  but a host looking at its logs could try to match a ballot request to a response request.
- **A dishonest server**: it could send different code to one person. The form code helps people
  spot a per-person key, but it cannot catch everything. A person who controls the server can also
  sign extra ballots, so the audit proves valid signatures and not that the operator is honest.
- **The crypto** is a small RSA blind signature written for this project and not independently
  reviewed. Do not use it for elections or anything with high stakes.
