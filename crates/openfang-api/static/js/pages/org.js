// OpenFang Org Management Page — template-based agent creation
'use strict';

function orgPage() {
  return {
    templates: [],
    agents: [],
    loading: true,
    loadError: '',
    showCreateModal: false,
    creating: false,
    createError: '',
    selectedTemplate: null,
    createForm: { name: '' },

    async loadData() {
      this.loading = true;
      this.loadError = '';
      try {
        var tData = await OpenFangAPI.get('/api/org/templates');
        this.templates = tData.templates || [];
        var agents = await OpenFangAPI.get('/api/agents');
        this.agents = agents || [];
      } catch(e) {
        this.loadError = e.message || 'Could not load templates.';
      }
      this.loading = false;
    },

    openCreateModal(template) {
      this.selectedTemplate = template;
      this.createForm = { name: template.name };
      this.createError = '';
      this.showCreateModal = true;
    },

    async createAgent() {
      if (!this.selectedTemplate) return;
      this.creating = true;
      this.createError = '';
      try {
        var result = await OpenFangAPI.post('/api/org/agents', {
          template_id: this.selectedTemplate.id,
          name: this.createForm.name || null,
        });
        this.showCreateModal = false;
        await this.loadData();
        if (typeof OpenFangToast !== 'undefined') {
          OpenFangToast.success('Agent created: ' + result.agent_name);
        }
      } catch(e) {
        this.createError = e.message || 'Failed to create agent.';
      }
      this.creating = false;
    },

    agentCountForTemplate(templateId) {
      return this.agents.filter(function(a) {
        return (a.tags || []).indexOf(templateId) !== -1 ||
               a.name === templateId ||
               a.name.startsWith(templateId);
      }).length;
    },
  };
}
