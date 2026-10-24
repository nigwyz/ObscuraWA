// Entry point for the injected crypto bundle.
//
// Obscura's WebCrypto implements only symmetric primitives; WhatsApp's Noise
// handshake needs Curve25519. @noble/curves is pure JS, so bundling it into an
// IIFE and handing it to the page gives us the missing primitives without any
// Rust changes.
import { x25519 } from '@noble/curves/ed25519';
import { ed25519 } from '@noble/curves/ed25519';

globalThis.__obscuraNoble = { x25519, ed25519 };
