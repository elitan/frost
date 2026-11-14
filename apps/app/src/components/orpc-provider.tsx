"use client";

import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { useState } from "react";
import { isUnauthorizedError } from "@/lib/orpc-client";

let redirectingToLogin = false;

function handleUnauthorized(error: unknown) {
  if (!isUnauthorizedError(error)) return;
  if (typeof window === "undefined") return;
  if (redirectingToLogin) return;
  const path = window.location.pathname;
  if (path === "/login" || path.startsWith("/setup")) return;
  redirectingToLogin = true;
  window.location.assign("/login");
}

export function ORPCProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({ onError: handleUnauthorized }),
        mutationCache: new MutationCache({ onError: handleUnauthorized }),
        defaultOptions: {
          queries: {
            staleTime: 0,
            refetchOnWindowFocus: true,
            retry: (failureCount, error) =>
              !isUnauthorizedError(error) && failureCount < 3,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
