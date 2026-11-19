<template>
  <div class="activity-controls">
    <div v-if="$activity.state.preview && !$store.state.streamLibraryItem" class="activity-preview-empty" role="status">
      <p>Nothing playing</p>
      <p>Open the Activity to choose a book.</p>
    </div>
    <div v-if="$activity.state.error" class="activity-warning" role="alert">{{ $activity.state.error }} <button @click="$activity.retry()">Try again</button></div>
    <div v-if="$activity.state.blocked" ref="unlock" class="activity-unlock" role="dialog" aria-modal="true" aria-label="Join playback" tabindex="-1">
      <p>Join playback</p><button @click="$activity.unlock()">Tap to play on this device</button>
    </div>
    <div v-if="$activity.state.rosterOpen" class="activity-dialog-backdrop" @click.self="$activity.state.rosterOpen = false">
      <section ref="roster" class="activity-dialog" role="dialog" aria-modal="true" aria-label="Listening party" tabindex="-1">
        <h2>Listening party</h2>
        <p v-if="$activity.state.roster.loading">Loading participants…</p>
        <p v-if="$activity.state.roster.error" role="status">{{ $activity.state.roster.error }}</p>
        <p v-if="!$activity.state.roster.loading && !$activity.state.roster.participants.length">No participants to display.</p>
        <ul><li v-for="person in $activity.state.roster.participants" :key="person.id"><img v-if="person.avatarUrl" :src="person.avatarUrl" alt="" /><span>{{ person.displayName }}{{ person.isSelf ? ' (You)' : '' }}</span></li></ul>
        <p class="activity-note">Playback, queue and speed are shared. Volume and sleep timers belong to you. Bookmarks and listening history belong to your selected account.</p>
        <button v-if="fullscreenAvailable" @click="$activity.fullscreen()">Fullscreen</button>
        <p v-else class="activity-note">Use Discord’s fullscreen control.</p>
        <button @click="$activity.state.rosterOpen = false">Close</button>
      </section>
    </div>
  </div>
</template>
<script>
import { createActivityDialogs } from '@/discordActivity/activityDialogs';
export default {
  computed: {
    fullscreenAvailable() { return typeof document !== 'undefined' && document.fullscreenEnabled === true; },
    dialog() { return this.$activity.state.rosterOpen ? 'roster' : this.$activity.state.blocked ? 'unlock' : null; }
  },
  watch: { dialog() { this.$nextTick(() => this.dialogs?.update()); } },
  mounted() {
    this.dialogs = createActivityDialogs(window, () => this.dialog && ({ element: this.$refs[this.dialog], dismissible: this.dialog === 'roster' }), () => { this.$activity.state.rosterOpen = false; });
    this.$activity.modalBack = () => this.dialogs.back();
    this.dialogs.update();
  },
  beforeDestroy() { this.$activity.modalBack = undefined; this.dialogs?.dispose(); }
};
</script>
<style src="@/discordActivity/activityLayout.css"></style>
