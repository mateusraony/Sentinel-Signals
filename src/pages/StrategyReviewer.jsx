import React, { useState, useEffect } from 'react';
import { backend } from '@/api/entities';
import { Bot, Plus, MessageSquare, Trash2, Send, Loader2 } from 'lucide-react';
import MessageBubble from '@/components/agent/MessageBubble';
import moment from 'moment';

export default function StrategyReviewer() {
  const [conversations, setConversations] = useState([]);
  const [activeConv, setActiveConv] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  // Load conversations on mount
  useEffect(() => {
    loadConversations();
  }, []);

  const loadConversations = async () => {
    try {
      setLoading(true);
      const convs = await backend.agents.listConversations({ agent_name: 'strategy_reviewer' });
      setConversations(convs || []);
    } catch (err) {
      console.error('Failed to load conversations:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleNewConversation = async () => {
    try {
      const conv = await backend.agents.createConversation({
        agent_name: 'strategy_reviewer',
        metadata: { name: `Análise ${moment().format('DD/MM HH:mm')}`, description: 'Revisão de estratégia' },
      });
      setConversations(prev => [conv, ...prev]);
      setActiveConv(conv);
      setMessages(conv.messages || []);
    } catch (err) {
      console.error('Failed to create conversation:', err);
    }
  };

  const handleSelectConv = async (conv) => {
    setActiveConv(conv);
    try {
      const full = await backend.agents.getConversation(conv.id);
      setMessages(full.messages || []);
    } catch (err) {
      setMessages(conv.messages || []);
    }
  };

  const handleSend = async () => {
    if (!input.trim() || !activeConv || sending) return;
    const userMsg = { role: 'user', content: input.trim() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setSending(true);
    try {
      const updated = await backend.agents.addMessage(activeConv, { role: 'user', content: userMsg.content });
      // Subscribe handled separately; addMessage triggers agent response
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      setSending(false);
    }
  };

  // Subscribe to active conversation for streaming updates
  useEffect(() => {
    if (!activeConv?.id) return;
    const unsubscribe = backend.agents.subscribeToConversation(activeConv.id, (data) => {
      setMessages(data.messages || []);
    });
    return () => { if (typeof unsubscribe === 'function') unsubscribe(); };
  }, [activeConv?.id]);

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground mb-1">Inteligência Artificial</p>
          <h1 className="text-3xl font-bold text-foreground tracking-tight">Strategy Reviewer</h1>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground">
          <div className="live-dot" style={{ width: 5, height: 5 }} />
          <span>Assistente de estratégia</span>
        </div>
      </div>

      <div className="h-[calc(100vh-12rem)] flex gap-4">
      {/* Sidebar — conversations list */}
      <div className="w-72 shrink-0 hidden lg:flex flex-col rounded-xl overflow-hidden"
        style={{ background: 'rgba(10,13,22,0.85)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="p-3 flex items-center justify-between" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
          <div className="flex items-center gap-2">
            <Bot className="w-4 h-4" style={{ color: '#00e5ff' }} />
            <span className="text-xs font-mono font-bold text-foreground">Análises</span>
          </div>
          <button onClick={handleNewConversation}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-[9px] font-mono transition-all"
            style={{ background: 'rgba(0,255,128,0.1)', border: '1px solid rgba(0,255,128,0.25)', color: '#00ff80' }}>
            <Plus className="w-3 h-3" />Nova
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
          ) : conversations.length === 0 ? (
            <div className="text-center py-8 px-3">
              <MessageSquare className="w-8 h-8 mx-auto mb-2 text-muted-foreground opacity-20" />
              <p className="text-[10px] font-mono text-muted-foreground">Nenhuma análise ainda.</p>
              <p className="text-[9px] font-mono text-muted-foreground mt-1">Clique em "Nova" para começar.</p>
            </div>
          ) : (
            conversations.map(conv => (
              <button key={conv.id} onClick={() => handleSelectConv(conv)}
                className="w-full text-left p-2.5 rounded-lg transition-all"
                style={activeConv?.id === conv.id
                  ? { background: 'rgba(0,229,255,0.08)', border: '1px solid rgba(0,229,255,0.2)' }
                  : { background: 'rgba(255,255,255,0.02)', border: '1px solid transparent' }}>
                <div className="text-[10px] font-mono font-semibold text-foreground truncate">
                  {conv.metadata?.name || 'Análise'}
                </div>
                <div className="text-[8px] font-mono text-muted-foreground mt-0.5">
                  {moment(conv.created_date).format('DD/MM HH:mm')}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Main — chat area */}
      <div className="flex-1 flex flex-col rounded-xl overflow-hidden"
        style={{ background: 'rgba(10,13,22,0.85)', border: '1px solid rgba(255,255,255,0.06)' }}>
        {/* Header */}
        <div className="p-3 flex items-center justify-between" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center"
              style={{ background: 'linear-gradient(135deg, rgba(0,229,255,0.18), rgba(0,180,255,0.08))', border: '1px solid rgba(0,229,255,0.22)' }}>
              <Bot className="w-3.5 h-3.5" style={{ color: '#00e5ff' }} />
            </div>
            <div>
              <div className="text-xs font-mono font-bold text-foreground">Strategy Reviewer</div>
              <div className="text-[9px] font-mono text-muted-foreground">
                {activeConv ? (activeConv.metadata?.name || 'Análise ativa') : 'Selecione ou crie uma análise'}
              </div>
            </div>
          </div>
          <button onClick={handleNewConversation}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-mono transition-all lg:hidden"
            style={{ background: 'rgba(0,255,128,0.1)', border: '1px solid rgba(0,255,128,0.25)', color: '#00ff80' }}>
            <Plus className="w-3 h-3" />Nova
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {!activeConv ? (
            <div className="h-full flex flex-col items-center justify-center text-center">
              <Bot className="w-12 h-12 mb-3 text-muted-foreground opacity-20" />
              <p className="text-sm text-muted-foreground mb-1">Strategy Reviewer AI</p>
              <p className="text-[10px] font-mono text-muted-foreground max-w-xs">
                Crie uma nova análise para revisar seu histórico de trades, win rate, gestão de risco e adesão à estratégia.
              </p>
              <button onClick={handleNewConversation}
                className="mt-4 flex items-center gap-1.5 px-4 py-2 rounded-lg text-[11px] font-mono font-bold transition-all"
                style={{ background: 'rgba(0,255,128,0.1)', border: '1px solid rgba(0,255,128,0.3)', color: '#00ff80' }}>
                <Plus className="w-3.5 h-3.5" />Iniciar Análise
              </button>
            </div>
          ) : messages.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-[10px] font-mono text-muted-foreground">
                Envie uma mensagem para iniciar a análise. Ex: "Analise meu histórico de trades da última semana"
              </p>
            </div>
          ) : (
            messages.map((msg, i) => <MessageBubble key={i} message={msg} />)
          )}
          {sending && (
            <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>Strategy Reviewer está analisando...</span>
            </div>
          )}
        </div>

        {/* Input */}
        {activeConv && (
          <div className="p-3" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSend()}
                placeholder="Pergunte sobre seu histórico de trades..."
                disabled={sending}
                className="flex-1 px-3 py-2.5 rounded-lg text-xs font-mono outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.85)' }}
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || sending}
                className="flex items-center justify-center w-10 h-10 rounded-lg transition-all"
                style={{ background: input.trim() && !sending ? 'rgba(0,255,128,0.12)' : 'rgba(255,255,255,0.04)', border: '1px solid rgba(0,255,128,0.25)', color: '#00ff80' }}>
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}