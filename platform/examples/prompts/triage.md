A {{ Trigger.severity }} alert fired for {{ Trigger.service }}.

Recent errors (last 15 minutes):
{{ Steps.Fetch_Recent_Errors.json }}

Recent deploys:
{{ Steps.Fetch_Recent_Deploys.json }}

Dashboard: {{ Trigger.dashboardUrl }}

In under 150 words: the most likely cause, the evidence for it, and the first
thing the on-call should check.
