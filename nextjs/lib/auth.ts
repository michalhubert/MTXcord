import NextAuth from "next-auth";
import type { NextAuthConfig } from "next-auth";
import Discord from "next-auth/providers/discord";
import Credentials from "next-auth/providers/credentials";
import { authConfig } from "./auth.config";
import { safeEqual, throttledLogin } from "./credentials";
import { getClientIp } from "./net";
import { isTrustedIp } from "./trustedNetworks";

export const config: NextAuthConfig = {
  ...authConfig,
  providers: [
    ...(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET
      ? [
          Discord({
            clientId: process.env.DISCORD_CLIENT_ID,
            clientSecret: process.env.DISCORD_CLIENT_SECRET,
            // Discord now sends the RFC 9207 `iss` param on the callback; without a
            // declared issuer Auth.js compares it to "https://authjs.dev" and rejects it.
            issuer: "https://discord.com",
            authorization: { params: { scope: "identify" } },
            profile(profile) {
              return {
                id: profile.id,
                name: profile.username,
                image: profile.avatar
                  ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
                  : null,
              };
            },
          }),
        ]
      : []),

    // Per-stream viewer password (stored in DB per path), for viewers without Discord
    Credentials({
      id: "viewer-password",
      name: "Viewer Password",
      credentials: {
        password: { label: "Password", type: "password" },
      },
      async authorize({ password }, request) {
        const { getAllViewerPasswords } = await import("@/lib/db");
        if (typeof password !== "string" || !password) return null;
        const match = throttledLogin(getClientIp(request), () =>
          Object.values(getAllViewerPasswords()).some((valid) => safeEqual(password, valid))
        );
        return match ? { id: "viewer", name: "Viewer", role: "viewer", password } : null;
      },
    }),

    // Clients on TRUSTED_NETWORKS join without the viewer password. They are still
    // ordinary guests: private streams need the streamer's approval.
    Credentials({
      id: "trusted-network",
      name: "Trusted Network",
      credentials: {},
      async authorize(_credentials, request) {
        if (!isTrustedIp(getClientIp(request))) return null;
        return { id: "viewer", name: "Viewer", role: "viewer", trusted: true };
      },
    }),

    // Static admin/streamer password, used to access the OBS streamer dock (/dock)
    Credentials({
      id: "streamer-password",
      name: "Streamer Password",
      credentials: {
        password: { label: "Password", type: "password" },
      },
      async authorize({ password }, request) {
        const streamerPassword = process.env.STREAMER_PASSWORD;
        if (!streamerPassword || typeof password !== "string") return null;
        const match = throttledLogin(getClientIp(request), () => safeEqual(password, streamerPassword));
        return match ? { id: "streamer", name: "Streamer", role: "streamer" } : null;
      },
    }),
  ],

  pages: {
    signIn: "/login",
  },

  callbacks: {
    async jwt(params) {
      const token = await authConfig.callbacks!.jwt!(params);
      if (!token) return token;
      const password = (params.user as { password?: string } | undefined)?.password;
      if (password) token.password = password;
      if ((params.user as { trusted?: boolean } | undefined)?.trusted) token.trusted = true;
      return token;
    },
    async session(params) {
      const session = await authConfig.callbacks!.session!(params);
      if (session.user) {
        (session.user as { password?: string }).password = params.token.password as string | undefined;
        (session.user as { trusted?: boolean }).trusted = params.token.trusted as boolean | undefined;
      }
      return session;
    },
  },

  secret: process.env.NEXTAUTH_SECRET,
};

export const { handlers, auth, signIn, signOut } = NextAuth(config);
