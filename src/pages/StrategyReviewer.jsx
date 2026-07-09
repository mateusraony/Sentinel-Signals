import { Bot } from 'lucide-react';

// Temporarily paused: the chat backend (an LLM call holding the Anthropic
// API key server-side) needs either the Firebase Blaze plan or a small
// Render backend like sentinel-signals-api/. Neither is set up yet — this
// placeholder avoids showing a chat UI that can't actually respond.
export default function StrategyReviewer() {
  return (
    <div className="max-w-2xl mx-auto py-24 flex flex-col items-center text-center gap-3">
      <Bot className="w-12 h-12 text-muted-foreground opacity-20" />
      <h1 className="text-xl font-bold text-foreground">Strategy Reviewer</h1>
      <p className="text-sm text-muted-foreground max-w-md">
        O assistente de IA está temporariamente pausado enquanto preparamos o backend que guarda a chave da API com segurança. Volta em breve.
      </p>
    </div>
  );
}
