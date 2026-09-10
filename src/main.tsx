import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App } from './frontend/App.js';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 401 means the session ended; retrying cannot fix that, and the guard
      // needs the answer promptly to send the employee back to login.
      retry: false,
      refetchOnWindowFocus: true,
      staleTime: 30_000,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
