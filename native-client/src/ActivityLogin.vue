<template>
  <main class="w-full h-screen overflow-auto flex items-center justify-center text-white bg-bg p-5">
    <div class="w-full max-w-md rounded-md border border-white/10 bg-primary p-6">
      <img src="/branding/audiobookshelf-listen-icon.png" alt="Audiobookshelf" class="w-12 h-12 mx-auto mb-3" />
      <h1 class="text-2xl text-center mb-2">Audiobookshelf Listen</h1>
      <p class="text-gray-300 text-center mb-5">Listen with the people in your Discord Activity.</p>
      <p v-if="error || $activity.state.error" role="alert" class="text-red-300 mb-4">{{ error || $activity.state.error }}</p>
      <p v-if="loading" role="status">Connecting to Discord…</p>
      <template v-else>
        <p v-if="party" class="text-sm text-gray-300 mb-3">Sign in to join this listening party.</p>
        <form v-if="options && options.passwordEnabled" @submit.prevent="signIn">
          <ui-text-input-with-label v-model.trim="username" label="Username" autocomplete="username" :disabled="busy" class="mb-3" />
          <ui-text-input-with-label v-model="password" label="Password" type="password" autocomplete="current-password" :disabled="busy" class="mb-4" />
          <ui-btn type="submit" :disabled="busy || !username" color="bg-success" class="w-full">Sign in</ui-btn>
        </form>
        <ui-btn v-if="options && options.oidcEnabled" :disabled="busy" class="w-full mt-3" color="bg-bg" @click="sso">Sign in with Authentik</ui-btn>
        <p v-if="waiting" role="status" class="text-sm text-gray-300 mt-2">Finish signing in in your browser. This Activity will connect automatically.</p>
        <ui-btn v-if="canCommunity" :disabled="busy" class="w-full mt-3" color="bg-bg" @click="community">Sign in as community user</ui-btn>
        <p v-if="canCommunity" class="text-xs text-gray-400 mt-2">The community user shares listening history and bookmarks.</p>
        <div v-if="saved.length" class="mt-5 border-t border-white/10 pt-3">
          <p class="text-sm text-gray-300 mb-2">Saved accounts</p>
          <ui-btn v-for="connection in saved" :key="connection.id" :disabled="busy" class="w-full mb-2" color="bg-bg" @click="select(connection)">{{ connection.audiobookshelfUsername }}</ui-btn>
        </div>
        <ui-btn v-if="error || $activity.state.error" :disabled="busy" class="w-full mt-3" color="bg-bg" @click="load">Try again</ui-btn>
        <ui-btn v-if="waiting" class="w-full mt-3" color="bg-bg" @click="cancel">Cancel sign-in</ui-btn>
      </template>
    </div>
  </main>
</template>
<script>
export default {
  layout: 'blank',
  data: () => ({ username: '', password: '', options: null, party: null, error: '', loading: true, busy: false, waiting: false, generation: 0, timer: null, timerResolve: null }),
  computed: { canCommunity() { return this.options?.communityAvailable; }, saved() { return (this.options?.connections || []).filter(value => !this.party || window.AudiobookshelfWatch.matchesPartyServer(value, this.party)); } },
  mounted() { this.load(); },
  beforeDestroy() { this.cancel(); },
  methods: {
    cancel() { this.generation++; clearTimeout(this.timer); this.timerResolve?.(); this.timerResolve = null; this.waiting = false; this.busy = false; this.password = ''; },
    async load() {
      const generation = ++this.generation;
      this.loading = true; this.error = '';
      try {
        const { data, party } = await this.$activity.load();
        if (generation !== this.generation) return;
        this.options = data; this.party = party;
      } catch (error) { if (generation === this.generation) this.error = error.message; }
      finally { if (generation === this.generation) this.loading = false; }
    },
    async run(action) {
      if (this.busy) return;
      const generation = ++this.generation;
      this.busy = true; this.error = '';
      try { const connection = await action(); if (generation === this.generation && connection) await this.$activity.select(connection); }
      catch (error) { if (generation === this.generation) this.error = error.message; }
      finally { if (generation === this.generation) { this.busy = false; this.waiting = false; this.password = ''; } }
    },
    signIn() { const input = { username: this.username, password: this.password }; this.password = ''; return this.run(() => this.$activity.call('connectAccount', input)); },
    community() { return this.run(() => this.$activity.call('connectCommunity')); },
    select(connection) { return this.run(() => connection); },
    sso() {
      return this.run(async () => {
        const generation = this.generation;
        const login = await this.$activity.call('startOidcLogin');
        if (generation !== this.generation) return;
        await this.$activity.openExternal(login.url);
        if (generation !== this.generation) return;
        this.waiting = true;
        while (generation === this.generation && Date.now() < Date.parse(login.expiresAt)) {
          await new Promise(resolve => { this.timerResolve = resolve; this.timer = setTimeout(() => { this.timerResolve = null; resolve(); }, 1500); });
          if (generation !== this.generation) return;
          const result = await this.$activity.call('pollOidcLogin', login.id);
          if (result.status === 'connected') return result.connection;
          if (result.status === 'failed') throw new Error(result.message);
        }
        if (generation === this.generation) throw new Error('Sign-in expired. Try again.');
      });
    }
  }
};
</script>
