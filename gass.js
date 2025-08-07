// ---------------------------------------------------------------------------
//OpenAI setup (optional – skip detection if key missing)
// ---------------------------------------------------------------------------
const openaiApiKey = process.env.OPENAI_API_KEY;
let openai = null;
if (openaiApiKey) {
  const configuration = new Configuration({ apiKey: openaiApiKey });
  openai = new OpenAIApi(configuration);
} else {
  console.warn(
    '[Mirror] OPENAI_API_KEY not provided – Indonesian comment detection disabled'
  );
}
