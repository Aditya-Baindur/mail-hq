# Email deliverability

The dashboard distinguishes submission to Cloudflare from delivery to a recipient. A recipient server accepting a message also does not reveal whether it placed that message in Inbox, a category, or Spam.

## What to inspect

Read the recipient's original message headers. Check SPF, DKIM, DMARC alignment, TLS, the envelope sender, message ID, Date, MIME structure, and the spam explanation provided by the recipient. Check Cloudflare sending events for deferrals or bounces. Do not assume an inbox-placement problem is a DNS problem.

A valid sender can pass SPF, DKIM, and DMARC and still be classified as spam. Tightening a DMARC policy does not force a recipient to put authenticated mail in its main inbox. Recipient filters also use reputation, content, sending patterns, and user interaction.

A tiny test such as subject “HI” and body “Hi” is not representative of normal correspondence. Use a small number of meaningful messages to recipients who expect them. Plus aliases point to the same Gmail inbox and are not independent reputation samples.

## Sending outcomes

- **Sent to Cloudflare:** the provider accepted the submission.
- **Failed:** a definitive rejection is recorded.
- **Uncertain:** submission may have occurred but confirmation was lost. Check provider events before retrying.
- A temporary SMTP 4xx response can be retried by the provider; do not immediately submit another copy yourself.

Keep raw recipient headers and provider event IDs private when investigating an incident. No historical mailbox messages or recipient logs are included in this repository.

References: [Cloudflare Email Service](https://developers.cloudflare.com/email-service/) and [Gmail sender guidelines](https://support.google.com/a/answer/81126).
