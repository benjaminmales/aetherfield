# Marketing Activation Studio

This app now supports Supabase authentication and cloud persistence per user project.

## 1) Configure environment variables

Copy `.env.example` to `.env.local` and set:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Then restart the dev server.

## 2) Create the Supabase table and policies

Run the SQL in `supabase-schema.sql` inside the Supabase SQL editor.

This creates:

- `activation_projects` table
- RLS policies so each user can only read/write their own rows

## 3) Run the app

```bash
npm install
npm run dev
```

## Notes

- Sign in/sign up is handled by Supabase Auth.
- Projects are stored in `activation_projects.state` as JSON (`venue` + `rules`).
- Changes auto-save when a project is selected.
