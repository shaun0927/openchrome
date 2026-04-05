/// <reference types="jest" />
/**
 * Tests for Action Templates
 */

import { matchTemplate, ACTION_TEMPLATES } from '../../src/actions/action-templates';
import { ParsedAction } from '../../src/actions/action-parser';

describe('matchTemplate', () => {
  // -------------------------------------------------------------------------
  // No match
  // -------------------------------------------------------------------------
  describe('no match', () => {
    it('returns null for unrecognized instructions', () => {
      expect(matchTemplate('xyzzy frobnicator 999')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(matchTemplate('')).toBeNull();
    });

    it('returns null for plain click instruction', () => {
      expect(matchTemplate('click the submit button')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Login template
  // -------------------------------------------------------------------------
  describe('login template', () => {
    it('matches "log in with user@test.com pass123"', () => {
      const result = matchTemplate('log in with user@test.com pass123');
      expect(result).not.toBeNull();
      expect(result!.template.id).toBe('login');
      expect(result!.actions).toHaveLength(3);
      expect(result!.actions[0]).toMatchObject<Partial<ParsedAction>>({
        action: 'type',
        target: 'email',
        value: 'user@test.com',
      });
      expect(result!.actions[1]).toMatchObject<Partial<ParsedAction>>({
        action: 'type',
        target: 'password',
        value: 'pass123',
      });
      expect(result!.actions[2]).toMatchObject<Partial<ParsedAction>>({
        action: 'click',
        target: 'login button',
      });
    });

    it('matches "sign in with admin secret"', () => {
      const result = matchTemplate('sign in with admin secret');
      expect(result).not.toBeNull();
      expect(result!.template.id).toBe('login');
      expect(result!.actions[0].value).toBe('admin');
      expect(result!.actions[1].value).toBe('secret');
    });

    it('matches case-insensitively', () => {
      const result = matchTemplate('LOG IN WITH user@example.com mypassword');
      expect(result).not.toBeNull();
      expect(result!.template.id).toBe('login');
    });

    it('produces well-formed ParsedAction arrays', () => {
      const result = matchTemplate('log in with user@test.com pass123');
      for (const action of result!.actions) {
        expect(action).toHaveProperty('action');
        expect(typeof action.action).toBe('string');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Korean login template
  // -------------------------------------------------------------------------
  describe('login-kr template', () => {
    it('matches Korean login instruction', () => {
      const result = matchTemplate('user@test.com과 pass123로 로그인');
      expect(result).not.toBeNull();
      expect(result!.template.id).toBe('login-kr');
      expect(result!.actions[0].value).toBe('user@test.com');
      expect(result!.actions[1].value).toBe('pass123');
      expect(result!.actions[2]).toMatchObject<Partial<ParsedAction>>({
        action: 'click',
        target: '로그인 버튼',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Search template
  // -------------------------------------------------------------------------
  describe('search template', () => {
    it('matches "search for OpenChrome"', () => {
      const result = matchTemplate('search for OpenChrome');
      expect(result).not.toBeNull();
      expect(result!.template.id).toBe('search');
      expect(result!.actions[0]).toMatchObject<Partial<ParsedAction>>({
        action: 'type',
        target: 'search',
        value: 'OpenChrome',
      });
      expect(result!.actions[1]).toMatchObject<Partial<ParsedAction>>({
        action: 'click',
        target: 'search button',
      });
    });

    it('matches "search OpenChrome" (without "for")', () => {
      const result = matchTemplate('search OpenChrome');
      expect(result).not.toBeNull();
      expect(result!.template.id).toBe('search');
      expect(result!.actions[0].value).toBe('OpenChrome');
    });

    it('matches "search for query in the search bar" with target', () => {
      const result = matchTemplate('search for my query in the search bar');
      expect(result).not.toBeNull();
      expect(result!.template.id).toBe('search');
      expect(result!.actions[0]).toMatchObject<Partial<ParsedAction>>({
        action: 'type',
        target: 'search bar',
        value: 'my query',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Korean search template
  // -------------------------------------------------------------------------
  describe('search-kr template', () => {
    it('matches Korean search instruction', () => {
      const result = matchTemplate('오픈크롬 검색');
      expect(result).not.toBeNull();
      expect(result!.template.id).toBe('search-kr');
      expect(result!.actions[0]).toMatchObject<Partial<ParsedAction>>({
        action: 'type',
        target: 'search',
        value: '오픈크롬',
      });
      expect(result!.actions[1]).toMatchObject<Partial<ParsedAction>>({
        action: 'click',
        target: '검색 버튼',
      });
    });

    it('matches Korean search with particle', () => {
      const result = matchTemplate('오픈크롬을 검색');
      expect(result).not.toBeNull();
      expect(result!.template.id).toBe('search-kr');
    });
  });

  // -------------------------------------------------------------------------
  // Fill form template
  // -------------------------------------------------------------------------
  describe('fill-form template', () => {
    it('matches "fill the form with name John, email john@test.com"', () => {
      const result = matchTemplate('fill the form with name John, email john@test.com');
      expect(result).not.toBeNull();
      expect(result!.template.id).toBe('fill-form');
      expect(result!.actions.length).toBeGreaterThanOrEqual(1);
      const nameAction = result!.actions.find(a => a.target === 'name');
      expect(nameAction).toBeDefined();
      expect(nameAction!.value).toBe('John');
    });

    it('matches "fill out the form with key value pairs"', () => {
      const result = matchTemplate('fill out the form with username admin, password secret');
      expect(result).not.toBeNull();
      expect(result!.template.id).toBe('fill-form');
      expect(result!.actions).toHaveLength(2);
    });

    it('produces type actions for each field', () => {
      const result = matchTemplate('fill the form with name John, email john@test.com');
      for (const action of result!.actions) {
        expect(action.action).toBe('type');
      }
    });
  });

  // -------------------------------------------------------------------------
  // goto-and-do template
  // -------------------------------------------------------------------------
  describe('goto-and-do template', () => {
    it('matches "go to https://example.com and click login"', () => {
      const result = matchTemplate('go to https://example.com and click login');
      expect(result).not.toBeNull();
      expect(result!.template.id).toBe('goto-and-do');
      expect(result!.actions[0]).toMatchObject<Partial<ParsedAction>>({
        action: 'navigate',
        value: 'https://example.com',
      });
    });

    it('matches "navigate to https://example.com then click submit"', () => {
      const result = matchTemplate('navigate to https://example.com then click submit');
      expect(result).not.toBeNull();
      expect(result!.template.id).toBe('goto-and-do');
    });
  });

  // -------------------------------------------------------------------------
  // Template metadata
  // -------------------------------------------------------------------------
  describe('ACTION_TEMPLATES metadata', () => {
    it('every template has id, name, description, pattern, build', () => {
      for (const tpl of ACTION_TEMPLATES) {
        expect(tpl.id).toBeTruthy();
        expect(tpl.name).toBeTruthy();
        expect(tpl.description).toBeTruthy();
        expect(tpl.pattern).toBeInstanceOf(RegExp);
        expect(typeof tpl.build).toBe('function');
      }
    });

    it('template ids are unique', () => {
      const ids = ACTION_TEMPLATES.map(t => t.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
