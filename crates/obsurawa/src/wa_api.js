// Minimal page-side API for the Rust controller.
//
// Everything is resolved at call time through the page's own module loader.
// The shapes mirror whatsapp-web.js, but only text messaging, chat lists and
// recent messages are implemented.
(function () {
  'use strict';
  if (window.__waApiInstalled) return;
  window.__waApiInstalled = true;
  window.__waApiStatus = 'installed';

  function collections() {
    return window.require('WAWebCollections');
  }

  function createWid(id) {
    return window.require('WAWebWidFactory').createWid(id);
  }

  async function getChat(chatId) {
    const wid = createWid(chatId);
    let chat = collections().Chat.get(wid);
    if (!chat) {
      try {
        chat = (await window.require('WAWebFindChatAction').findOrCreateLatestChat(wid))?.chat;
      } catch (e) {
        chat = null;
      }
    }
    return chat;
  }

  function serialized(value) {
    if (!value) return null;
    return value._serialized || value.$1 || null;
  }

  window.__waChats = async () => {
    const chats = collections().Chat.getModelsArray().slice(0, 300);
    return chats
      .map((chat) => {
        let model = {};
        try {
          model = chat.serialize() || {};
        } catch (e) {
          model = {};
        }
        return {
          id: serialized(chat.id) || serialized(model.id),
          name: chat.formattedTitle || chat.name || model.name || null,
          isGroup: !!(chat.groupMetadata || model.isGroup),
          unreadCount: chat.unreadCount ?? model.unreadCount ?? 0,
          timestamp: chat.t ?? model.t ?? 0,
          lastMessage: model.lastMessage?.body ?? null,
        };
      })
      .filter((chat) => chat.id);
  };

  window.__waMessages = async (chatId, limit) => {
    const chat = await getChat(chatId);
    if (!chat || !chat.msgs) return [];
    let messages = chat.msgs.getModelsArray();
    if (limit > 0 && messages.length > limit) {
      messages = messages.slice(-limit);
    }
    return messages.map((message) => {
      let model = {};
      try {
        model = message.serialize() || {};
      } catch (e) {
        model = {};
      }
      const id = model.id || message.id || {};
      return {
        id: serialized(id),
        chatId,
        from: id.fromMe
          ? 'me'
          : serialized(id.participant) || serialized(id.remote) || null,
        to: serialized(id.remote),
        body: model.body ?? message.body ?? '',
        timestamp: model.t ?? message.t ?? 0,
        fromMe: !!(id.fromMe ?? message.id?.fromMe),
        ack: model.ack ?? message.ack ?? 0,
        hasMedia: !!(model.isMedia || message.mediaObject),
      };
    });
  };

  window.__waContacts = async () => {
    const contacts = collections().Contact.getModelsArray().slice(0, 300);
    return contacts.map((contact) => {
      let model = {};
      try {
        model = contact.serialize() || {};
      } catch (e) {
        model = {};
      }
      return {
        id: serialized(contact.id) || serialized(model.id),
        name: contact.name || model.name || null,
        pushname: contact.pushname || model.pushname || null,
        number: contact.phoneNumber || model.phoneNumber || null,
        isBusiness: !!(contact.isBusiness || model.isBusiness),
      };
    }).filter((contact) => contact.id);
  };

  window.__waSendText = async (chatId, text) => {
    const chat = await getChat(chatId);
    if (!chat) throw new Error('chat not found: ' + chatId);

    const me = window.require('WAWebUserPrefsMeUser');
    const lidUser = me.getMaybeMeLidUser();
    const meUser = me.getMaybeMePnUser();
    const newId = await window.require('WAWebMsgKey').newId();
    const from =
      typeof chat.id.isLid === 'function' && chat.id.isLid() ? lidUser : meUser;

    let participant;
    if (typeof chat.id.isGroup === 'function' && chat.id.isGroup()) {
      participant = window.require('WAWebWidFactory').asUserWidOrThrow(from);
    }

    const newMsgKey = new (window.require('WAWebMsgKey'))({
      from,
      to: chat.id,
      id: newId,
      participant,
      selfDir: 'out',
    });

    let ephemeral = {};
    try {
      ephemeral = window
        .require('WAWebGetEphemeralFieldsMsgActionsUtils')
        .getEphemeralFields(chat);
    } catch (e) {
      ephemeral = {};
    }

    const message = {
      id: newMsgKey,
      ack: 0,
      body: text,
      from,
      to: chat.id,
      local: true,
      self: 'out',
      t: Math.floor(Date.now() / 1000),
      isNewMsg: true,
      type: 'chat',
      ...ephemeral,
    };

    const [messagePromise] = window
      .require('WAWebSendMsgChatAction')
      .addAndSendMsgToChat(chat, message);
    await messagePromise;

    return {
      id: serialized(newMsgKey),
      chatId,
      body: text,
      fromMe: true,
      timestamp: message.t,
    };
  };
})();
