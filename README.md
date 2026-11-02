# Anything

**Try it here:** https://anything-g7.onrender.com

Anything is an anonymous feedback and polling tool for IITGN, built by Group G7 for CS437.

If you've ever filled in a course feedback form and wondered whether it was really anonymous, you'll see why we built this. With a sign-in, you have to trust that nobody connects your name to your answer. Without one, anyone can respond, and they can respond as many times as they like.

Anything gives you both. The organiser decides who can respond, each person can respond once, and the saved response doesn't say who sent it.

It works for course feedback, mess feedback, and club or council polls. See [SPEC.md](SPEC.md) for exactly what the app promises.

## How to use it

**If you're running a poll:**

1. Create a form and list who can respond, one person per line.
2. Bookmark your manage page. It's the only way back to your form.
3. Send each person their own invite link.
4. Check back for results, which appear once 3 people have responded.

**If you've been invited:**

1. Open your link on the device you'll respond from.
2. Click **Get my ballot**.
3. Answer the questions and send your response.

The app doesn't send emails, so organisers share the links themselves.

## Run it on your laptop

You'll need Node.js 20.12 or newer. You don't need to install a database.

```sh
npm install && npm start
```

Then open http://localhost:3000. Your data is saved in `./data`.

## Run the tests

```sh
npm install && npm test
```

This runs 23 tests. Every statement in `SPEC.md` has a test, and the suite fails if a statement doesn't have one.

The browser tests cover using the app on a phone, blinding, and showing text safely. They run separately:

```sh
npx playwright install chromium
npm run test:e2e
```

To run the API tests on real Postgres, set `TEST_DATABASE_URL`. GitHub Actions also runs them on every pull request.

## Deploy your own copy

1. On [Render](https://render.com), choose **New > Blueprint** and select this repo.
2. Accept the plan in `render.yaml`. It sets up the web service and a Postgres database, and connects them.
3. Open the `onrender.com` link when the deploy finishes.

A few things to know about Render's free plan:

- The app goes to sleep after 15 minutes without visitors, so the next visit can take about a minute. Open it yourself before a demo.
- The free database expires 30 days after it's created. To keep your data for longer, create a free database on [Neon](https://neon.tech) and set its URL as `DATABASE_URL`.
- Always set `DATABASE_URL` in production. Without it, your data is lost whenever the app restarts.

## How the anonymity works

Think of a sealed envelope lined with carbon paper. You put your ballot inside and hand it over. The organiser checks your name and stamps the outside, and the stamp transfers to the ballot without anyone seeing it. You then take the ballot out and drop it in the box. It carries a valid stamp, but nobody can tell whose it is.

In the app, this is done with RSA blind signatures:

1. Your browser creates a random token and hides it using a random number.
2. The server checks your invite, marks it as used, and signs the hidden value.
3. Your browser removes the hiding, leaving a valid signature the server has never seen.
4. You send the token, the signature and your answers. The server checks the signature, marks the token as spent, and stores your answers in a separate table.

The random number never leaves your browser, and it's the only thing that connects your invite to your ballot. The code is in `public/blind.js`.

## What it can't protect against

We'd rather be clear about the limits:

- **Your own words.** Written answers can give you away, so leave out details only you would know.
- **Very small groups.** Results stay hidden until there are 3 responses, but that's still not much of a crowd. An organiser who keeps refreshing could also compare results before and after a new response, then guess who sent it from who just collected a ballot.
- **Hosting logs.** The app doesn't store IP addresses or response times, but the hosting provider can see them and could try to match requests.
- **A dishonest server operator.** Someone who controls the server could send one person different code or sign extra ballots. The form code helps people spot a different key, but it can't catch everything. The response check shows that signatures are valid, not that the operator is honest.
- **Unreviewed crypto.** We wrote the blind signature code for this project, and nobody has independently reviewed it.

It's a good fit for feedback and low-stakes polls, but please don't use it for elections or anything high-stakes.
