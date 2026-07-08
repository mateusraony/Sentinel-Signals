import { httpsCallable } from 'firebase/functions';
import { collection, doc, addDoc, getDoc, getDocs, query, where, orderBy, onSnapshot } from 'firebase/firestore';
import { auth, db, functions } from '@/lib/firebaseClient';

function toRecord(docSnap) {
  return { id: docSnap.id, ...docSnap.data() };
}

async function fetchMessages(conversationId) {
  const snap = await getDocs(query(
    collection(db, 'agentConversations', conversationId, 'messages'),
    orderBy('created_date', 'asc'),
  ));
  return snap.docs.map(toRecord);
}

// Mirrors the base44.agents.* call shape StrategyReviewer.jsx already uses.
// Message replies are produced server-side by the strategyReviewerChat Cloud
// Function (which holds the Anthropic API key) — the client never talks to
// the LLM API directly.
export const strategyReviewerAgent = {
  async listConversations() {
    const uid = auth.currentUser?.uid;
    if (!uid) return [];
    const snap = await getDocs(query(collection(db, 'agentConversations'), where('user_id', '==', uid)));
    return snap.docs.map(toRecord).sort((a, b) => (b.created_date || '').localeCompare(a.created_date || ''));
  },

  async createConversation({ agent_name, metadata } = {}) {
    const uid = auth.currentUser?.uid;
    const payload = {
      user_id: uid,
      agent_name: agent_name || 'strategy_reviewer',
      metadata: metadata || {},
      created_date: new Date().toISOString(),
    };
    const ref = await addDoc(collection(db, 'agentConversations'), payload);
    return { id: ref.id, ...payload, messages: [] };
  },

  async getConversation(id) {
    const convSnap = await getDoc(doc(db, 'agentConversations', id));
    const messages = await fetchMessages(id);
    return { id, ...convSnap.data(), messages };
  },

  async addMessage(conversation, { content }) {
    const call = httpsCallable(functions, 'strategyReviewerChat');
    await call({ conversationId: conversation.id, content });
  },

  subscribeToConversation(conversationId, callback) {
    const q = query(collection(db, 'agentConversations', conversationId, 'messages'), orderBy('created_date', 'asc'));
    return onSnapshot(q, (snap) => {
      callback({ messages: snap.docs.map(toRecord) });
    });
  },
};
