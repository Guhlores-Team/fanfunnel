# Auth email templates

Branded HTML for Supabase Auth emails. Supabase does not read these files from
the repo for hosted projects: paste each one into **Authentication → Emails →
Templates** in BOTH the test and prod projects whenever it changes.

| File | Template | Subject |
|---|---|---|
| `recovery.html` | Reset password | Reset your password |
| `confirmation.html` | Confirm signup | Confirm your email |
| `magic_link.html` | Magic link | Your sign-in link |
| `invite.html` | Invite user | You're invited |
| `email_change.html` | Change email address | Confirm your new email |

Every template shows the link twice (button + plain URL) because Gmail disables
buttons in mail it files as spam, and some clients strip styled anchors.
