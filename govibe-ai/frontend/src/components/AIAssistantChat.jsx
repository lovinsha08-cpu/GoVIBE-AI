import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bot, X, Send, Loader2, Sparkles, RotateCcw, RefreshCw } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { api, getCurrentLocation, messageNeedsLocation } from "../lib/api";

const COPY = {
  traveler: {
    title: "AI Travel Assistant",
    subtitle: "Ask about destinations, routes & planning",
    placeholder: "Ask about a destination, budget, or your trip...",
    suggestions: [
      "Suggest a 3-day plan for Goa",
      "What's a good budget for a solo trip to Jaipur?",
      "Find hidden gems near Udaipur",
    ],
    greeting: "Hey! I'm your GoVIBE AI Travel Assistant. Ask me about destinations, budgets, hidden gems, or your saved trips.",
  },
  business: {
    title: "AI Business Assistant",
    subtitle: "Get help with offers, listings & growth",
    placeholder: "Ask about offers, pricing, or visibility...",
    suggestions: [
      "How can I make my offer more attractive?",
      "Tips to get more traveler bookings",
      "Review my current offers",
    ],
    greeting: "Hi! I'm your GoVIBE AI Business Assistant. Ask me about your offers, listing, analytics, or how to attract more travelers.",
  },
};

export default function AIAssistantChat({ isOpen, onClose, mode = "traveler", tripId }) {
  const copy = COPY[mode] || COPY.traveler;
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [lastFailedText, setLastFailedText] = useState(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  // Restore persisted conversation history (requirement: "conversation
  // history") for the general assistant — trip-scoped chats stay
  // session-only, matching existing behavior, since the backend only
  // persists the no-trip-id conversation.
  useEffect(() => {
    if (!isOpen || historyLoaded) return;
    setHistoryLoaded(true);
    if (tripId) {
      setMessages([{ role: "assistant", content: copy.greeting }]);
      return;
    }
    api
      .getAssistantHistory()
      .then(({ messages: past }) => {
        setMessages(past?.length ? past : [{ role: "assistant", content: copy.greeting }]);
      })
      .catch(() => setMessages([{ role: "assistant", content: copy.greeting }]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, historyLoaded]);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 250);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  async function sendMessage(text) {
    const trimmed = (text ?? input).trim();
    if (!trimmed || sending) return;

    const history = messages.map(({ role, content }) => ({ role, content }));
    setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
    setInput("");
    setError(null);
    setLastFailedText(null);
    setSending(true);

    try {
      // Only ask for geolocation permission when the message actually
      // seems to need it (e.g. "juice shop near me") — never on every turn.
      const location = messageNeedsLocation(trimmed) ? await getCurrentLocation() : null;
      const { reply } = await api.assistantChat({ message: trimmed, history, mode, tripId, location });
      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
    } catch (err) {
      setError(err.message || "Something went wrong — please try again.");
      setLastFailedText(trimmed);
    } finally {
      setSending(false);
    }
  }

  function retryLastMessage() {
    if (!lastFailedText) return;
    // The failed user bubble is already in `messages` — just re-run the
    // network call for it instead of re-appending a duplicate bubble.
    const text = lastFailedText;
    setLastFailedText(null);
    setError(null);
    setSending(true);
    (async () => {
      try {
        const history = messages.slice(0, -1).map(({ role, content }) => ({ role, content }));
        const location = messageNeedsLocation(text) ? await getCurrentLocation() : null;
        const { reply } = await api.assistantChat({ message: text, history, mode, tripId, location });
        setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
      } catch (err) {
        setError(err.message || "Something went wrong — please try again.");
        setLastFailedText(text);
      } finally {
        setSending(false);
      }
    })();
  }

  function resetChat() {
    setMessages([{ role: "assistant", content: copy.greeting }]);
    setError(null);
    setLastFailedText(null);
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-[#0C3B5E]/40 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 z-50"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 40 }}
            transition={{ type: "spring", damping: 28, stiffness: 300 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full sm:max-w-lg h-[88vh] sm:h-[640px] bg-[#EAF7EF] rounded-t-3xl sm:rounded-3xl flex flex-col overflow-hidden shadow-2xl"
          >
            {/* Header */}
            <div className="bg-[#0C3B5E] text-white px-5 py-4 flex items-center gap-3 shrink-0">
              <div className="w-11 h-11 rounded-2xl bg-[#16A34A] flex items-center justify-center shrink-0">
                <Bot size={22} />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-display font-bold text-lg leading-tight truncate">{copy.title}</h3>
                <p className="text-white/60 text-xs truncate">{copy.subtitle}</p>
              </div>
              <button
                onClick={resetChat}
                title="Start a new chat"
                className="w-9 h-9 rounded-full flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors shrink-0"
              >
                <RotateCcw size={16} />
              </button>
              <button
                onClick={onClose}
                title="Close"
                className="w-9 h-9 rounded-full flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors shrink-0"
              >
                <X size={18} />
              </button>
            </div>

            {/* Messages */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5 space-y-4">
              {messages.map((m, i) => (
                <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  {m.role === "assistant" && (
                    <div className="w-8 h-8 rounded-xl bg-[#16A34A] flex items-center justify-center shrink-0 mr-2 mt-0.5">
                      <Bot size={16} className="text-white" />
                    </div>
                  )}
                  <div
                    className={`max-w-[78%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                      m.role === "user"
                        ? "bg-[#0C3B5E] text-white rounded-br-sm whitespace-pre-wrap"
                        : "bg-white text-[#0C3B5E] border border-[#0C3B5E]/10 rounded-bl-sm markdown-chat-bubble"
                    }`}
                  >
                    {m.role === "assistant" ? (
                      <ReactMarkdown
                        components={{
                          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                          ul: ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>,
                          ol: ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>,
                          strong: ({ children }) => <strong className="font-bold">{children}</strong>,
                          a: ({ children, href }) => (
                            <a href={href} target="_blank" rel="noreferrer" className="underline text-[#16A34A]">
                              {children}
                            </a>
                          ),
                        }}
                      >
                        {m.content}
                      </ReactMarkdown>
                    ) : (
                      <span className="whitespace-pre-wrap">{m.content}</span>
                    )}
                  </div>
                </div>
              ))}

              {sending && (
                <div className="flex justify-start">
                  <div className="w-8 h-8 rounded-xl bg-[#16A34A] flex items-center justify-center shrink-0 mr-2 mt-0.5">
                    <Bot size={16} className="text-white" />
                  </div>
                  <div className="bg-white border border-[#0C3B5E]/10 rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1.5">
                    {[0, 1, 2].map((d) => (
                      <motion.span
                        key={d}
                        className="w-1.5 h-1.5 rounded-full bg-[#0C3B5E]/40"
                        animate={{ opacity: [0.3, 1, 0.3] }}
                        transition={{ duration: 1, repeat: Infinity, delay: d * 0.15 }}
                      />
                    ))}
                  </div>
                </div>
              )}

              {error && (
                <div className="text-xs text-[#2563EB] bg-[#DBEAFE] rounded-xl px-3 py-2 flex items-center justify-between gap-2">
                  <span>{error}</span>
                  {lastFailedText && (
                    <button
                      onClick={retryLastMessage}
                      disabled={sending}
                      className="flex items-center gap-1 font-semibold shrink-0 hover:underline disabled:opacity-50"
                    >
                      <RefreshCw size={12} /> Retry
                    </button>
                  )}
                </div>
              )}

              {/* Suggestions — only before the conversation really starts */}
              {messages.length <= 1 && !sending && (
                <div className="flex flex-col gap-2 pt-2">
                  {copy.suggestions.map((s) => (
                    <button
                      key={s}
                      onClick={() => sendMessage(s)}
                      className="text-left text-xs font-medium text-[#0C3B5E]/70 bg-white border border-[#0C3B5E]/10 rounded-xl px-3 py-2.5 hover:border-[#16A34A] hover:text-[#0C3B5E] transition-colors flex items-center gap-2"
                    >
                      <Sparkles size={12} className="text-[#22C55E] shrink-0" />
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Input */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                sendMessage();
              }}
              className="p-3 border-t border-[#0C3B5E]/10 bg-white flex items-center gap-2 shrink-0"
            >
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={copy.placeholder}
                disabled={sending}
                className="flex-1 rounded-full bg-[#EAF7EF] border border-[#0C3B5E]/10 px-4 py-2.5 text-sm text-[#0C3B5E] placeholder:text-[#0C3B5E]/40 focus:outline-none focus:border-[#16A34A] disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={sending || !input.trim()}
                className="w-10 h-10 rounded-full bg-[#0C3B5E] text-white flex items-center justify-center disabled:opacity-30 transition-opacity shrink-0"
              >
                {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              </button>
            </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}