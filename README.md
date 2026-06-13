# LENS Backend

## Setup

1. Create Supabase project at supabase.com
2. Run schema.sql in SQL Editor
3. Deploy to Vercel:

```
vercel
```

4. Add env vars in Vercel dashboard:
- LENS_SUPABASE_URL
- LENS_SUPABASE_SERVICE_KEY  
- LENS_SUPABASE_ANON_KEY
- LENS_ETHERSCAN_KEY
- CRON_SECRET

## How it works

- `/api/index-launches` — runs every 5 min via Vercel Cron, fetches Bankrbot launches → saves to Supabase
- `/api/lookup?username=vvveity` — called by LENS extension, returns tokens + fees + dev sells for any X profile

## Extension Update

After deploy, update LENS extension config with:
- `LENS_API_URL = https://your-vercel-url.vercel.app`
