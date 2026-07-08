import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { ChevronDown, ChevronRight, Bot, User } from 'lucide-react';

function FunctionDisplay({ toolCall }) {
  const [expanded, setExpanded] = useState(false);

  const status = toolCall.status || 'completed';
  const isFailed = ['failed', 'error'].includes(status) ||
    (typeof toolCall.results === 'string' && /error|failed/i.test(toolCall.results));
  const isPending = ['pending', 'running', 'in_progress'].includes(status);

  let statusText = 'Concluído';
  let statusColor = '#00ff80';
  if (isFailed) { statusText = 'Falhou'; statusColor = '#ff1478'; }
  if (isPending) { statusText = 'Executando...'; statusColor = '#ffd166'; }

  const hideDetails = toolCall.display_projection?.hide_details && toolCall.display_projection?.details_redacted;
  const label = toolCall.display_projection?.label || toolCall.name;
  const activeLabel = toolCall.display_projection?.active_label;
  const errorLabel = toolCall.display_projection?.error_label;

  let displayLabel = label;
  if (isPending && activeLabel) displayLabel = activeLabel;
  if (isFailed && errorLabel) displayLabel = errorLabel;

  let parsedResults = toolCall.results;
  try {
    if (typeof toolCall.results === 'string') parsedResults = JSON.parse(toolCall.results);
  } catch { /* keep raw */ }

  let parsedArgs = toolCall.arguments_string;
  try {
    if (typeof toolCall.arguments_string === 'string') parsedArgs = JSON.parse(toolCall.arguments_string);
  } catch { /* keep raw */ }

  if (hideDetails) {
    return (
      <div className="mt-2 flex items-center gap-2 text-[10px] font-mono" style={{ color: statusColor }}>
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor }} />
        {displayLabel} — {statusText}
      </div>
    );
  }

  return (
    <div className="mt-2 text-xs">
      <button onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-[10px] font-mono transition-all"
        style={{ color: statusColor }}>
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor }} />
        {displayLabel} — {statusText}
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-1.5 pl-4">
          {parsedArgs && (
            <div>
              <span className="text-[9px] font-mono text-muted-foreground">Parâmetros:</span>
              <pre className="text-[9px] font-mono mt-0.5 p-2 rounded overflow-x-auto"
                style={{ background: 'rgba(0,0,0,0.3)', color: 'rgba(0,229,255,0.6)' }}>
                {JSON.stringify(parsedArgs, null, 2)}
              </pre>
            </div>
          )}
          {parsedResults && (
            <div>
              <span className="text-[9px] font-mono text-muted-foreground">Resultado:</span>
              <pre className="text-[9px] font-mono mt-0.5 p-2 rounded overflow-x-auto"
                style={{ background: 'rgba(0,0,0,0.3)', color: isFailed ? '#ff1478' : 'rgba(0,255,128,0.6)' }}>
                {typeof parsedResults === 'string' ? parsedResults : JSON.stringify(parsedResults, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function MessageBubble({ message }) {
  const isUser = message.role === 'user';

  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div className={`max-w-[85%] rounded-xl px-4 py-2.5 ${isUser ? '' : ''}`}
        style={isUser
          ? { background: 'rgba(0,229,255,0.08)', border: '1px solid rgba(0,229,255,0.2)' }
          : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center gap-1.5 mb-1">
          {isUser
            ? <User className="w-3 h-3" style={{ color: '#00e5ff' }} />
            : <Bot className="w-3 h-3" style={{ color: '#00ff80' }} />}
          <span className="text-[8px] font-mono uppercase tracking-wider"
            style={{ color: isUser ? '#00e5ff' : '#00ff80' }}>
            {isUser ? 'Você' : 'Strategy Reviewer'}
          </span>
        </div>
        {message.content && (
          isUser
            ? <p className="text-xs text-foreground leading-relaxed">{message.content}</p>
            : <ReactMarkdown className="text-xs text-foreground/90 leading-relaxed prose prose-sm prose-invert max-w-none">{message.content}</ReactMarkdown>
        )}
        {message.tool_calls?.map((toolCall, idx) => <FunctionDisplay key={idx} toolCall={toolCall} />)}
      </div>
    </div>
  );
}