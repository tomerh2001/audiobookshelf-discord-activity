<template>
  <main class="page text-white p-6 overflow-auto">
    <div class="max-w-xl mx-auto">
      <h1 class="text-2xl mb-5">Your account</h1>
      <p class="mb-2">{{ $store.state.user.user && $store.state.user.user.username }}</p>
      <p v-if="$activity.controller.selection" class="text-gray-300 mb-5">Audiobookshelf<span v-if="$activity.controller.selection.kind === 'community'"> · Community user with shared listening history</span></p>
      <p v-if="error" role="alert" class="text-red-300 mb-4">{{ error }}</p>
      <div class="flex flex-wrap gap-3">
        <ui-btn :disabled="busy" color="bg-bg" @click="run('switchAccounts')">Switch account</ui-btn>
        <ui-btn :disabled="busy" color="bg-primary" @click="run('logout')">Sign out of Audiobookshelf</ui-btn>
        <ui-btn :disabled="busy" color="bg-bg" @click="run('retry')">Try connecting again</ui-btn>
        <ui-btn :disabled="busy" color="bg-bg" @click="run('leave')">Leave listening party</ui-btn>
      </div>
      <p class="text-sm text-gray-400 mt-5">Switching keeps your saved accounts. Signing out removes this saved account. Leaving the Activity keeps your Discord voice call connected.</p>
    </div>
  </main>
</template>
<script>
export default { data: () => ({ busy: false, error: '' }), methods: { async run(method) { if (this.busy) return; this.busy = true; this.error = ''; try { await this.$activity[method](); } catch (error) { this.error = error.message; } finally { this.busy = false; } } } };
</script>
