// Asymmetric WebCrypto, layered over Obscura's symmetric-only subtle.
//
// Obscura's crypto.subtle (crates/obscura-js/js/bootstrap.js:17056) implements
// digest/HMAC/AES/PBKDF2/HKDF and throws NotSupportedError for every public-key
// algorithm. WhatsApp's Noise handshake needs X25519, so the page sends its
// 43-byte hello, receives the 350-byte server hello, then dies at the DH step
// and retries forever.
//
// This wraps crypto.subtle: X25519 and Ed25519 are served by @noble/curves
// (window.__obscuraNoble), everything else is delegated to the native object.
// Keys are plain objects with __bytes, since Obscura's own CryptoKey class is
// closure-private and not exposed on window.
(function () {
  'use strict';

  var noble = globalThis.__obscuraNoble;
  var subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!noble || !subtle) return;
  if (subtle.__obscuraAsymPatched) return;
  subtle.__obscuraAsymPatched = true;

  var nativeFns = {};
  [
    'generateKey', 'importKey', 'exportKey', 'deriveBits', 'deriveKey',
    'sign', 'verify', 'digest', 'encrypt', 'decrypt', 'wrapKey', 'unwrapKey',
  ].forEach(function (name) {
    if (typeof subtle[name] === 'function') nativeFns[name] = subtle[name].bind(subtle);
  });

  var SPKI_PREFIX = {
    X25519: [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00],
    Ed25519: [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00],
  };
  var PKCS8_PREFIX = {
    X25519: [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20],
    Ed25519: [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20],
  };
  var CRV = { X25519: 'X25519', Ed25519: 'Ed25519' };

  function curveOf(algorithm) {
    var name = String((algorithm && algorithm.name) || '').toUpperCase();
    if (name === 'X25519') return 'X25519';
    if (name === 'ED25519') return 'Ed25519';
    // Older WebCrypto spellings: ECDH with namedCurve X25519, ECDSA with
    // namedCurve Ed25519. Some libraries still emit these.
    if (name === 'ECDH' && String(algorithm.namedCurve || '').toUpperCase() === 'X25519') return 'X25519';
    if (name === 'ECDSA' && String(algorithm.namedCurve || '').toUpperCase() === 'ED25519') return 'Ed25519';
    return null;
  }

  function algorithmFor(curve, requested) {
    if (requested && String(requested.name || '').toUpperCase() === 'ECDH') {
      return { name: 'ECDH', namedCurve: curve };
    }
    if (requested && String(requested.name || '').toUpperCase() === 'ECDSA') {
      return { name: 'ECDSA', namedCurve: curve };
    }
    return { name: curve };
  }

  function toBytes(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new TypeError('Key data must be a BufferSource');
  }

  function bufferOf(bytes) {
    var copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return copy.buffer;
  }

  function hex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += ('0' + bytes[i].toString(16)).slice(-2);
    return out;
  }

  function equalBytes(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function indexOfSeq(haystack, needle) {
    outer: for (var i = 0; i + needle.length <= haystack.length; i++) {
      for (var j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  }

  // RFC 8410 SPKI/PKCS#8 wrap the raw key. Tolerate the optional public key
  // that PKCS#8 encoders may append.
  function unwrapDer(curve, format, bytes) {
    if (format === 'spki') {
      var i = indexOfSeq(bytes, [0x03, 0x21, 0x00]);
      if (i < 0 || i + 35 > bytes.length) throw new DOMException('Invalid SPKI for ' + curve, 'DataError');
      return bytes.slice(i + 3, i + 35);
    }
    var j = indexOfSeq(bytes, [0x04, 0x22, 0x04, 0x20]);
    if (j >= 0 && j + 36 <= bytes.length) return bytes.slice(j + 4, j + 36);
    // Some encoders use a shorter OCTET STRING wrapping (30 20 ...).
    var k = indexOfSeq(bytes, [0x04, 0x20]);
    if (k >= 0 && k + 34 <= bytes.length) return bytes.slice(k + 2, k + 34);
    throw new DOMException('Invalid PKCS#8 for ' + curve, 'DataError');
  }

  function b64urlToBytes(text) {
    var s = String(text).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64url(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function makeKey(type, algorithm, bytes, extractable, usages) {
    var key = {
      type: type,
      extractable: !!extractable,
      algorithm: algorithm,
      usages: Object.freeze((usages || []).slice()),
      __bytes: bytes,
      __obscuraAsymmetric: true,
    };
    Object.defineProperty(key, Symbol.toStringTag, { value: 'CryptoKey' });
    return key;
  }

  function isKey(value) {
    return !!value && value.__obscuraAsymmetric === true && value.__bytes instanceof Uint8Array;
  }

  function requireKey(value, types, usage) {
    if (!isKey(value)) throw new DOMException('Argument is not a valid CryptoKey', 'InvalidAccessError');
    if (types && types.indexOf(value.type) < 0) throw new DOMException('Key type is not usable here', 'InvalidAccessError');
    if (usage && value.usages.indexOf(usage) < 0) throw new DOMException('Key does not allow ' + usage, 'InvalidAccessError');
    return value;
  }

  function pairFor(curve, requested, extractable, usages) {
    var algorithm = algorithmFor(curve, requested);
    var privateUsages = (usages && usages.length) ? usages : (curve === 'X25519' ? ['deriveBits'] : ['sign']);
    var priv, pub;
    if (curve === 'X25519') {
      priv = noble.x25519.utils.randomSecretKey();
      pub = noble.x25519.getPublicKey(priv);
    } else {
      priv = noble.ed25519.utils.randomSecretKey();
      pub = noble.ed25519.getPublicKey(priv);
    }
    return {
      privateKey: makeKey('private', algorithm, priv, extractable, privateUsages),
      publicKey: makeKey('public', algorithm, pub, true, []),
    };
  }

  // ---------------------------------------------------------------- generateKey
  subtle.generateKey = async function (algorithm, extractable, usages) {
    var curve = curveOf(algorithm);
    if (curve) return pairFor(curve, algorithm, extractable, usages);
    return nativeFns.generateKey(algorithm, extractable, usages);
  };

  // ------------------------------------------------------------------ importKey
  subtle.importKey = async function (format, keyData, algorithm, extractable, usages) {
    var curve = curveOf(algorithm);
    if (!curve) return nativeFns.importKey(format, keyData, algorithm, extractable, usages);

    var algObj = algorithmFor(curve, algorithm);
    var bytes;
    var type = 'public';

    if (format === 'raw') {
      bytes = toBytes(keyData).slice();
      if (bytes.length !== 32) throw new DOMException('Invalid ' + curve + ' key length', 'DataError');
      if (usages && usages.indexOf('sign') >= 0) type = 'public';
    } else if (format === 'spki') {
      bytes = unwrapDer(curve, 'spki', toBytes(keyData));
    } else if (format === 'pkcs8') {
      bytes = unwrapDer(curve, 'pkcs8', toBytes(keyData));
      type = 'private';
    } else if (format === 'jwk') {
      var jwk = keyData || {};
      if (String(jwk.crv || '').toUpperCase().replace('-', '') !== curve.toUpperCase()) {
        throw new DOMException('JWK curve does not match ' + curve, 'DataError');
      }
      if (typeof jwk.d === 'string') {
        bytes = b64urlToBytes(jwk.d);
        type = 'private';
      } else if (typeof jwk.x === 'string') {
        bytes = b64urlToBytes(jwk.x);
      } else {
        throw new DOMException('JWK has no key material', 'DataError');
      }
    } else {
      throw new DOMException('Unsupported key format: ' + format, 'NotSupportedError');
    }

    if (bytes.length !== 32) throw new DOMException('Invalid ' + curve + ' key length', 'DataError');
    return makeKey(type, algObj, bytes, extractable, usages);
  };

  // ------------------------------------------------------------------ exportKey
  subtle.exportKey = async function (format, key) {
    if (!isKey(key)) return nativeFns.exportKey(format, key);
    var curve = curveOf(key.algorithm);
    if (!curve) throw new DOMException('Unsupported key algorithm', 'NotSupportedError');
    if (!key.extractable) throw new DOMException('Key is not extractable', 'InvalidAccessError');
    var bytes = key.__bytes;

    if (format === 'raw') {
      if (key.type !== 'public') throw new DOMException('raw export is only valid for public keys', 'InvalidAccessError');
      return bufferOf(bytes);
    }
    if (format === 'spki') {
      if (key.type !== 'public') throw new DOMException('spki export is only valid for public keys', 'InvalidAccessError');
      var spki = new Uint8Array(SPKI_PREFIX[curve].length + 32);
      spki.set(SPKI_PREFIX[curve], 0);
      spki.set(bytes, SPKI_PREFIX[curve].length);
      return bufferOf(spki);
    }
    if (format === 'pkcs8') {
      if (key.type !== 'private') throw new DOMException('pkcs8 export is only valid for private keys', 'InvalidAccessError');
      var pkcs8 = new Uint8Array(PKCS8_PREFIX[curve].length + 32);
      pkcs8.set(PKCS8_PREFIX[curve], 0);
      pkcs8.set(bytes, PKCS8_PREFIX[curve].length);
      return bufferOf(pkcs8);
    }
    if (format === 'jwk') {
      var jwkOut = {
        crv: CRV[curve],
        ext: key.extractable,
        key_ops: key.usages.slice(),
        kty: 'OKP',
      };
      if (key.type === 'private') jwkOut.d = bytesToB64url(bytes);
      else jwkOut.x = bytesToB64url(bytes);
      return jwkOut;
    }
    throw new DOMException('Unsupported export format: ' + format, 'NotSupportedError');
  };

  // ------------------------------------------------------------------ deriveBits
  subtle.deriveBits = async function (algorithm, baseKey, length) {
    var curve = curveOf(algorithm);
    if (curve === 'X25519') {
      requireKey(baseKey, ['private']);
      var peer = algorithm && algorithm.public;
      requireKey(peer, ['public']);
      var secret = noble.x25519.getSharedSecret(baseKey.__bytes, peer.__bytes);
      var wanted = length == null ? 32 : Math.ceil(length / 8);
      if (wanted < 0 || wanted > 32) throw new DOMException('deriveBits length must be <= 256', 'OperationError');
      return bufferOf(secret.slice(0, wanted));
    }
    return nativeFns.deriveBits(algorithm, baseKey, length);
  };

  // ----------------------------------------------------------------------- sign
  subtle.sign = async function (algorithm, key, data) {
    var curve = curveOf(algorithm);
    if (curve === 'Ed25519') {
      requireKey(key, ['private']);
      return bufferOf(noble.ed25519.sign(toBytes(data), key.__bytes));
    }
    return nativeFns.sign(algorithm, key, data);
  };

  // --------------------------------------------------------------------- verify
  subtle.verify = async function (algorithm, key, signature, data) {
    var curve = curveOf(algorithm);
    if (curve === 'Ed25519') {
      requireKey(key, ['public']);
      try {
        return noble.ed25519.verify(toBytes(signature), toBytes(data), key.__bytes);
      } catch (e) {
        return false;
      }
    }
    return nativeFns.verify(algorithm, key, signature, data);
  };

  // Debug hook used by the spike gates; never consulted by page code.
  subtle.__obscuraAsym = {
    curveOf: curveOf,
    isKey: isKey,
    hex: hex,
    equalBytes: equalBytes,
  };
})();
