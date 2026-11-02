# SPEC: Anything (G7)

> **What our user said:** TODO, replace with one real sentence from a real user, with their role.
> For example, ask a mess representative or a club secretary. Do not make this up.

## Who the user is

Any IITGN member who needs honest feedback or a low-stakes poll from a known group, without
being able to link a response to the person who gave it: course instructors, mess
representatives, and club, council or student-body secretaries.

## What they do today

They use Google Forms or a similar web form. With sign-in, people must trust the organiser and
the platform not to connect their name to their answer. Without sign-in, anyone can respond,
and one person can respond many times.

## What changes

The organiser lists who may respond. Each person gets one anonymous ballot and can use it once.
Only people on the list can respond, and the stored response does not say who gave it.

## Words used below

- **Organiser**: the person who created the form and holds its private manage link.
- **Participant**: a person on the organiser's list, holding a personal invite link.
- **Ballot**: the anonymous credential: a random token with a blind signature from the form's key.

## What they can do

Each line is one checkable promise. The tag at the start is the name of its test.

### Creating and managing a form

- **S1** An organiser can create a form with rating, single-choice, multiple-choice and text questions and a list of participants, without creating an account.
- **S2** Creating a form gives the organiser a private manage link and one personal invite link for each participant.
- **S3** Only someone holding the manage link can see the participant list, the results or the audit.
- **S4** An organiser can add participants to an open form, and each one gets a new invite link.
- **S5** An organiser can close a form, and after that no ballots are issued and no responses are accepted.

### Who can respond

- **S6** A participant with a valid invite can collect exactly one ballot, and a second ballot from the same invite is refused.
- **S7** Someone without a valid invite cannot collect a ballot.
- **S8** A response with a made-up ballot is refused.
- **S9** A ballot issued for one form is refused on any other form.
- **S10** A ballot can be used for exactly one response, even if it is sent twice at the same moment.
- **S11** If a participant's connection drops while collecting a ballot, retrying from the same browser gets the same ballot and no extra one.

### Anonymity

- **S12** The server never receives a participant's ballot token or signature while issuing it, only a blinded value.
- **S13** A stored response has no participant name, invite, ballot token, signature or time, and nothing else that points back to the issuing record.
- **S14** Every participant of a form sees the same key fingerprint, so a key made for one person would be noticed.

### Answers and results

- **S15** A response that is missing a required answer, or gives an answer that the question does not allow, is refused and the ballot stays usable.
- **S16** The organiser sees how many people are eligible, how many ballots were collected and how many responses were accepted.
- **S17** The organiser can check that every accepted response used a validly signed ballot, and a stored ballot that was tampered with is reported.
- **S18** The organiser sees counts for choice questions, the average and spread for ratings, and all text answers.
- **S19** Results stay hidden until at least 3 responses are in, so a single person's answer cannot be read off.
- **S20** The organiser can download responses as CSV, in an order unrelated to when they arrived, and spreadsheet formulas in answers are made harmless.
- **S21** Text from a form or a response is always shown as plain text, never run as code on the page.

### Reliability

- **S22** Forms, ballots and responses are still there after the server restarts.
- **S23** On a phone-sized screen, an organiser can create a form and a participant can open their invite, respond and see that it was accepted, using only the web pages.
