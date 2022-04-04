<script setup lang="ts">
import GitHub from './icons/GitHub.vue'
</script>

<template>
  <header
    class="h-16 w-full border-b border-stone-300 bg-white/30 px-6 backdrop-blur"
  >
    <div
      class="mx-auto flex h-full w-full max-w-7xl items-center justify-between"
    >
      <a href="/" aria-label="Oak Tree" class="text-xl hover:opacity-50">
        <img class="h-10" alt="Oak Tree" src="/logo.svg" />
      </a>
      <a href="https://github.com/dotoleeoak" target="_blank">
        <GitHub class="h-6 text-stone-600/75 hover:text-stone-600/50" />
      </a>
    </div>
  </header>
</template>
