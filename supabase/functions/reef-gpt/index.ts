import { createReefGptHandler, createSupabaseStateReader } from "../../../services/reefGptApiService.js";

const url = Deno.env.get("SUPABASE_URL") || "";
const handler = createReefGptHandler({
  token: Deno.env.get("REEF_GPT_READ_TOKEN"),
  ownerUserId: Deno.env.get("REEF_GPT_USER_ID"),
  baseUrl: `${url}/functions/v1/reef-gpt`,
  loadOwnedState: createSupabaseStateReader({
    url,
    serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  }),
});

Deno.serve(handler);
