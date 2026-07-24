DAWAK CASH CUSTODY-ONLY WEBSITE v0.7.0
========================================

Removed from the website frontend:
- Delivery Assist tab and page
- Delivery AWB lookup
- Previous delivery locations and map pins
- Delivery call-attempt controls
- Delivery WhatsApp function
- Driver Assist camera scanner
- All Driver Assist JavaScript calls and state

Preserved:
- Secure login and profile/hub access
- Individual CASH/CARD AWB records
- AWB custody lookup
- Mixed-destination transport bags
- Hub reconciliation and AWB scanning
- Custody acknowledgments, transfers, audit history and proof photos
- Shared Supabase connection used by Cash Custody

Deployment:
Upload/commit the full contents of this folder to the existing GitHub Pages
repository, replacing the current website files. The service-worker cache was
renamed to force devices to receive the Cash Custody-only version.

Important:
This update removes Driver Assist from the website frontend only. Its old
Supabase tables/RPCs have not been deleted yet. Confirm Cash Custody works after
deployment, then remove the Driver Assist database objects in the next step.
