'use client';
import { createContext, useContext, useEffect, useState } from 'react';

type WebSocketContextType = {
  socket: WebSocket | null;
  lastMessage: any | null;
};

const WebSocketContext = createContext<WebSocketContextType>({ socket: null, lastMessage: null });

export const useWebSocket = () => useContext(WebSocketContext);

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [lastMessage, setLastMessage] = useState<any | null>(null);

  useEffect(() => {
    const ws = new WebSocket('ws://localhost:8000/ws');
    
    ws.onopen = () => console.log('Connected to WebSocket');
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setLastMessage(data);
      } catch (e) {
        console.error('Failed to parse websocket message', e);
      }
    };
    ws.onclose = () => console.log('WebSocket disconnected');

    setSocket(ws);

    return () => {
      ws.close();
    };
  }, []);

  return (
    <WebSocketContext.Provider value={{ socket, lastMessage }}>
      {children}
    </WebSocketContext.Provider>
  );
};
