<template>
  <div class="activity-controls">
    <div class="activity-toolbar">
      <button aria-label="Back" title="Back" @click="$activity.back()">←</button>
      <button @click="$activity.roster()">Listening party</button>
      <button v-if="snapshot && snapshot.queue.length" aria-label="Previous item" @click="$activity.player.previous()">Previous</button>
      <button v-if="snapshot && snapshot.queue.length" aria-label="Next item" @click="$activity.player.next()">Next</button>
      <select v-if="snapshot && snapshot.queue.length" aria-label="Party repeat mode" :value="snapshot.repeatMode" @change="$activity.player.repeat($event.target.value)">
        <option value="RepeatNone">No repeat</option><option value="RepeatOne">Repeat one</option><option value="RepeatAll">Repeat all</option>
      </select>
      <button class="activity-fullscreen" @click="$activity.fullscreen()">Fullscreen</button>
    </div>
    <div v-if="$activity.state.error" class="activity-warning" role="alert">{{ $activity.state.error }} <button @click="$activity.retry()">Try again</button></div>
    <div v-if="$activity.state.blocked" class="activity-unlock" role="dialog" aria-label="Join playback">
      <p>Join playback</p><button @click="$activity.unlock()">Tap to play on this device</button>
    </div>
    <div v-if="$activity.state.rosterOpen" class="activity-dialog-backdrop" @click.self="$activity.state.rosterOpen = false">
      <section class="activity-dialog" role="dialog" aria-modal="true" aria-label="Listening party">
        <h2>Listening party</h2>
        <p v-if="$activity.state.roster.loading">Loading participants…</p>
        <p v-if="$activity.state.roster.error" role="status">{{ $activity.state.roster.error }}</p>
        <p v-if="!$activity.state.roster.loading && !$activity.state.roster.participants.length">No participants to display.</p>
        <ul><li v-for="person in $activity.state.roster.participants" :key="person.id"><img v-if="person.avatarUrl" :src="person.avatarUrl" alt="" /><span>{{ person.displayName }}{{ person.isSelf ? ' (You)' : '' }}</span></li></ul>
        <p class="activity-note">Playback, queue and speed are shared. Volume and sleep timers belong to you. Bookmarks and listening history belong to your selected account.</p>
        <button @click="$activity.state.rosterOpen = false">Close</button>
      </section>
    </div>
  </div>
</template>
<script>
export default { computed: { snapshot() { return this.$activity.state.snapshot; } } };
</script>
<style>
.page{height:calc(100% - 102px);max-height:calc(100% - 102px)}.page.streaming{height:calc(100% - 102px - 165px);max-height:calc(100% - 102px - 165px)}
.activity-toolbar{display:flex;align-items:center;gap:.5rem;min-height:38px;padding:4px 12px;background:#1c1d20;color:#eee;border-bottom:1px solid #ffffff14;font-size:13px;overflow-x:auto;white-space:nowrap}
.activity-toolbar button,.activity-toolbar select,.activity-dialog button,.activity-unlock button,.activity-warning button{border:1px solid #ffffff30;border-radius:5px;padding:4px 9px;background:#2e3034;color:white;cursor:pointer}
.activity-fullscreen{margin-left:auto}.activity-controls{position:relative;z-index:70}.activity-dialog-backdrop{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#000a;padding:20px;z-index:500}
.activity-dialog{max-height:85vh;overflow:auto;width:360px;background:#202124;padding:24px;border-radius:12px;color:#eee}.activity-dialog h2{font-size:21px;margin-bottom:15px}.activity-dialog li{display:flex;align-items:center;gap:10px;margin:10px 0}.activity-dialog img{width:32px;height:32px;border-radius:50%}.activity-note{font-size:12px;color:#b6b8bc;margin:18px 0}
.activity-warning{position:absolute;top:100%;left:0;right:0;padding:8px 15px;background:#5b3b1a;color:#fff}.activity-unlock{position:fixed;inset:auto 10% 30%;z-index:400;text-align:center;padding:20px;background:#202124f5;color:#fff;border:1px solid #fff5;border-radius:12px}.activity-unlock p{margin-bottom:12px}
.activity-preview #appbar,.activity-preview .activity-toolbar,.activity-preview #app-content,.activity-preview .has-siderail{display:none!important}.activity-preview #mediaPlayerContainer{bottom:0!important}
</style>
