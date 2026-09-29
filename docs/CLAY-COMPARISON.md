# The same Clay run, in Clay and in Free Clay

A usual small Clay workflow, run on 2026-09-29 in Clay (free plan) and then rebuilt in Free Clay on
the same three companies: Gumloop, Lindy and Relay (all AI automation tools). Company names only
here: the people found and their emails stay in the private tables.

## The workflow

1. **Company data** from the domain.
2. **A decision-maker** at the company (title: CEO / Founder), one per company.
3. **Their work email**, from a waterfall of providers with a verification step.
4. **A two-sentence opener** written by AI from the person, their title and what the company does.
5. **Send**: not run. Clay's own Sequencer needs a paid upgrade; both tools would push to
   Instantly, Smartlead or HubSpot, and nothing was sent to anyone.

## What each step returned

| Step | Clay | Free Clay |
|---|---|---|
| Company data | 3/3: name, website, employee count, industry, description (Clay "Enrich company") | 3/3: name, industry, location through treg; employee count 0/3 from the provider that answered. Description read live from each company's own site (free Website check) |
| Decision-maker | 2/3 ("No profile found" for Relay) | **3/3** (treg people search, one row each) |
| Work email | 2/3 (Clay "Work Email" waterfall, 11 providers) | 3/3 found; the verifier rated all three **catch-all** (the domain accepts any address, so no one can confirm the mailbox). Accepted only when the column is set to "valid or catch-all". One matched Clay's exactly; one differed (built from the full first name, where Clay used the short one) |
| Opener | 2/3, row 3 skipped as "Some inputs missing" (GPT 5.4 Mini via Clay) | 3/3 (Groq free tier). Relay's opener noticed the company had shut down: a run condition on "Site status" would skip it |
| Relay | Clay's description said the service shut down in September 2026 | The live site says the same. Worth a filter before anything is sent |

## What it cost

| | Clay | Free Clay |
|---|---|---|
| Company data | 0.5 credits a row (Clay's label) | $0.0019 a row (treg's charge) |
| Decision-maker | 0.5 credits a row | $0 a row (treg's charge) |
| Work email | ~1.1 credits a row (Clay's label) | ~$0.0048 a row + ~$0.0008 to verify (treg's charges) |
| Opener | 1 credit a row (GPT 5.4 Mini) | $0 (Groq free tier) |
| **3 companies, all steps** | **5.7 credits and 11 actions** (Clay's usage page, before and after) | **~$0.023** (Free Clay's ledger, one clean pass) |
| In dollars | ~$0.29 at Clay's $0.05 a credit on Launch (Clay's figure), on a $185/month plan | ~$0.023, on Cloudflare's free plan |

## What the comparison changed in Free Clay

Found by running the two side by side, fixed and tested the same day:

- **Run columns** button on every table, with the most it can cost, so a table built from a
  template has an obvious next step.
- **Columns wait for the columns they read**, row by row, including output columns (Description
  filled by Company data), so an AI column never runs on empty inputs because it was started first.
- **An AI row with any empty input is skipped** and says which input, as Clay does. Before, one blank
  made the model invent the gap ("[Company Name]").
- **A prompt with no column is refused.** Clay warns about this but saves it anyway.
- **Find a contact at a company** is now a column (treg, one person per row, capped at $0.05).
- **A verifier outage is a retryable error**, not a silent miss. Before, two paid-for emails were
  dropped when the verifier answered 503.
- **"Valid or catch-all" is a choice** in the email waterfall; "valid only" stays the default.
- **Company data reads treg's raw answer** when the normalised one is empty (industry and
  description were there, under other names).
- **Form placeholders are not contacts** (you@company.com came from a sign-up form).

## What Clay has that Free Clay still does not

- **Message column**: a subject and body template with variables, AI snippets, conditional
  snippets and spintax, made for a sequencer. Free Clay has AI columns and an "outreach email
  draft" agent template instead.
- **Prompt generator**: Clay turns a one-line description into a structured prompt
  (#CONTEXT#, #OBJECTIVE#) and picks a model. Free Clay's describe-a-table box plans columns, not
  prompts.
- **"Try on 5 rows"** before saving an AI column.
- **Employee counts** came from Clay's own data on all three; treg's first provider had none.
