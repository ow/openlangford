Last updated: October 30, 2026

## The short version

- Open Langford mostly publishes public council records: agendas, minutes, votes and meeting video.
- These records name councillors, City staff and some residents who spoke or wrote to council. You can ask us to correct a name, or replace a resident's name with "a resident".
- You don't need an account to use the site. If you create one, we keep your email, your settings and anything you choose to save, such as your address for local alerts. You can delete your account at any time.
- We use PostHog to see how the site is used, including the searches and questions people type. We don't send it your IP address or anything that identifies you.
- Questions you ask are sent to OpenAI so it can write an answer.
- We don't sell your information, we don't show ads, and we don't use your activity for marketing.

## Who we are

Open Langford (openlangford.ca) is an independent project run by Langford resident Owen Williams. It is not run by, paid for or endorsed by the City of Langford. The City's own records are the official source.

In this policy, "we" means Owen, who runs the site and is responsible for how it handles personal information. For privacy questions or requests, email [support@openlangford.ca](mailto:support@openlangford.ca) or use the [contact page](/contact).

## What we publish from public records

### What it is

We collect council agendas, minutes, reports, bylaws and meeting video from the City of Langford's public websites. We turn them into summaries, voting records, transcripts and searchable pages. The City publishes all of this material itself.

These records name people:

- **Councillors and City staff.** We show their names, how councillors voted, what they said in meetings, and how often they attended.
- **Residents who spoke to council or wrote letters.** We show a resident's name only when the meeting record shows it, for example when the minutes list it or the person said their name on the recording. Otherwise we call them "a resident". We leave house and unit numbers, phone numbers and email addresses out of our summaries.
- **Properties.** Pages list addresses that council considered, such as a rezoning site. We don't publish a page for an address that appears only because a resident gave it as their home address.

### Meeting video and transcripts

Council meetings are public and the City records them. We play the City's video on our site and make a written transcript of what was said. The transcript is word for word, so it may include anything a speaker said aloud. {{video_privacy}} When you press play, your browser connects to that provider.

### Identifying speakers

To label who is talking, we compare voices in the recording with voice samples of councillors and City staff. These voice samples are kept private. They are never shown on the site or shared, and we use them only to label speakers. We don't keep voice samples of residents who speak at a meeting.

### Why we do this

We publish this information so residents can follow and understand what their council decides. It comes from public records and public meetings, and we use it for the same purpose: public discussion of council business.

### Asking for a correction or removal

Our pages are put together with automated tools and AI, and they can be wrong. A speaker may be mislabelled, or a name misspelled.

If you are named on the site and want something corrected, or you are a resident and want your name replaced with "a resident", email [support@openlangford.ca](mailto:support@openlangford.ca) or use the [contact page](/contact). Tell us the page and what you want changed. We aim to reply within 30 days. We can't change the City's own records; for those, contact the City of Langford.

## Information we collect when you use the site

### If you just browse

You don't need an account. When you visit, we and the services we use collect:

- **Usage analytics (PostHog).** The pages you view, including the web address; links and buttons you click; searches you run; and when you play, pause or skip through meeting video. PostHog gets a random ID that lasts only while your browser tab is open, so it can tell visits apart. It uses no cookie. We've set PostHog to discard IP addresses, we don't send it your account or email, and we don't record your screen.
- **Server and security logs (Cloudflare).** Our hosting provider, Cloudflare, handles every request. It sees your IP address, the page you asked for and your browser type, and uses them to deliver the site and block abuse. We use your IP address for a moment to limit how many searches or messages can come from one place, and don't store it for that.
- **Your theme choice.** If you pick light or dark mode, your browser remembers it. This stays on your device.

### If you search or ask a question

- Your question, and earlier questions in the same conversation, go to **OpenAI** to find relevant records and write an answer. We send the question and public council records, never your name, email or account details. We ask OpenAI not to store the request, and its policy is not to use information sent through its API to train its models. See [OpenAI's privacy policy](https://openai.com/policies/privacy-policy).
- We keep each AI answer, with the question that produced it, for 30 days, so the next person who asks gets the same answer and you can share a link to it. Anyone with that link can see the question and answer, so please don't put personal information in a question.
- The question and answer also go to **PostHog** (without your IP address) so we can check the quality and cost of answers.

### If you create an account

To sign up, you give us your email address, a password and, if you like, a display name. We use **Supabase** to run accounts. Your password is stored in scrambled (hashed) form, so we can't read it. Supabase sends you a confirmation email.

Once you have an account, you can choose to save:

- **Things to follow:** topics, projects, people and keywords. Keywords you type are sent to OpenAI to help match them to council business.
- **A street address or neighbourhood**, for alerts about decisions near you. When you look up an address, we send it to OpenStreetMap's Nominatim service to find its map location. We store the address you typed and its map location, use it only to work out what's nearby, and never show it on the site.
- **Email alert settings**, including when you agreed to get alerts.
- **API keys**, if you use our data API. We store only a scrambled version of each key.

### If you sign up for email alerts

Alerts go only to a confirmed email address, and only after you opt in. We send them through **Resend**, with open and click tracking turned off. For each email we keep a record of the address it went to, the subject, a short preview and whether it was delivered. Every alert has a one-click unsubscribe link. If you unsubscribe, we keep your email address on a "do not send" list so we don't email you again by mistake.

### If you use the contact form

We collect your name (optional), your email address, your message and the IP address you sent it from. We use the IP address only to stop spam. The message is saved in our database and emailed to the site admin through Resend. Only the admin can read it, and we use your email only to reply to you.

## Cookies and browser storage

| Name | Set by | What it's for | How long |
|---|---|---|---|
| `sb-…-auth-token` (may be split into several cookies) | Open Langford (Supabase) | Keeps you signed in | Up to 400 days, or until you sign out |
| `onboarding_notice` | Open Langford | Shows a one-time "you're all set" message after setup | 2 minutes |
| PostHog visit ID (browser storage, not a cookie) | PostHog | A random ID that tells visits apart | Until you close the tab |
| Theme setting (browser storage) | Open Langford | Remembers light or dark mode | Until you clear it |
| `__cf_bm` (only sometimes) | Cloudflare | Bot protection | 30 minutes |

We don't use advertising or analytics cookies. You can block analytics with a tracker-blocking extension, and the site still works.

## Who we share information with

We don't sell personal information. We share it only with these service providers, and only so they can run parts of the site for us:

| Service | What it does for us | What it gets | Where |
|---|---|---|---|
| Supabase | Database and accounts | Account details, settings, contact messages, email records | Canada (Montréal) |
| Cloudflare | Hosting, security and AI request routing | Every web request, including your IP address; AI questions pass through it on their way to OpenAI (we don't log them there) | Worldwide, mainly USA |
| OpenAI | Writes answers and helps match searches and keywords | Questions, earlier questions in the conversation, keywords | USA |
| PostHog | Usage analytics | Page views, clicks, searches and questions, without IP addresses | USA |
| Resend | Sends alert and contact-form emails | Email address and email content | USA (Virginia) |
| OpenStreetMap Nominatim | Finds the map location of an address you enter | The address you typed | United Kingdom / EU |
| The City's video provider | Plays meeting video | Your IP address when you press play | Set by the City's provider |

Your account and the site's database are stored in Canada. Some of these providers store information outside Canada, mostly in the United States. While it is there, the laws of that country apply, and authorities there may be able to access it.

We may also share information if the law requires it.

## How long we keep information

- **Your account and settings:** until you delete your account.
- **AI answers and the questions that produced them:** 30 days.
- **Analytics:** kept by PostHog under our account's retention settings. We don't keep a separate copy.
- **Email delivery records:** the recipient's address is removed after 12 months. The "do not send" list is kept for as long as we send email.
- **Contact messages:** deleted 12 months after they arrive.
- **Cloudflare logs:** a few days.

## Your choices and rights

Under British Columbia's Personal Information Protection Act (PIPA), you can:

- **Ask what personal information we hold about you,** how we've used it and who we've shared it with.
- **Ask us to correct it** if it's wrong.
- **Withdraw your consent,** for example by turning off email alerts or deleting your account. If you do, we may not be able to provide that service.

You can change your saved address, interests and alert settings, or delete your account, on your [settings page](/settings). Deleting your account removes your profile, saved items, alert settings and API keys, cancels any unsent email, and removes your email address from our email records. If an email to you ever bounced or was marked as spam, we keep that address on our "do not send" list so we never email it again. You can unsubscribe from alerts with the link in any alert email.

We'll reply to requests within 30 days. If you're not happy with our answer, you can complain to the [Office of the Information and Privacy Commissioner for BC](https://www.oipc.bc.ca).

## How we protect information

- Your account data can be read only by you and the site admin. The database enforces this.
- Contact messages, email records, AI question logs and voice samples can be read only by the server, never by the public website.
- Admin access needs an approved, confirmed email address.
- Passwords and API keys are stored in scrambled form only.
- All traffic uses HTTPS.

No system is perfectly secure. If a breach puts your personal information at real risk, we'll tell you.

## Children

This site is meant for adults following local government. We don't knowingly collect personal information from children under 13. If you believe a child has created an account, contact us and we'll delete it.

## Changes to this policy

If we change this policy, we'll update the date at the top. If a change affects how we use information you've already given us, we'll tell account holders by email before it takes effect.

## Contact

Email [support@openlangford.ca](mailto:support@openlangford.ca) or use the [contact page](/contact).
