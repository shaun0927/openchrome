/// <reference types="jest" />
/**
 * Tests for Action Parser
 */

import { parseInstruction, ParsedAction } from '../../src/actions/action-parser';

describe('parseInstruction', () => {
  // -------------------------------------------------------------------------
  // Empty / invalid input
  // -------------------------------------------------------------------------
  describe('empty and invalid input', () => {
    it('returns error for empty string', () => {
      const result = parseInstruction('');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/empty/i);
      expect(result.suggestion).toBeTruthy();
      expect(result.actions).toHaveLength(0);
    });

    it('returns error for whitespace-only string', () => {
      const result = parseInstruction('   ');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/empty/i);
    });

    it('returns error with suggestion for unparseable instruction', () => {
      const result = parseInstruction('xyzzy frobnicator 999');
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
      expect(result.suggestion).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Single actions — English
  // -------------------------------------------------------------------------
  describe('single click actions', () => {
    it('parses "click the login button"', () => {
      const result = parseInstruction('click the login button');
      expect(result.success).toBe(true);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]).toMatchObject<Partial<ParsedAction>>({
        action: 'click',
        target: 'login button',
      });
    });

    it('parses "press the submit button"', () => {
      const result = parseInstruction('press the submit button');
      expect(result.success).toBe(true);
      expect(result.actions[0].action).toBe('click');
    });

    it('parses "tap the OK button"', () => {
      const result = parseInstruction('tap the OK button');
      expect(result.success).toBe(true);
      expect(result.actions[0].action).toBe('click');
    });
  });

  describe('single type actions', () => {
    it('parses "type hello in the search box"', () => {
      const result = parseInstruction('type hello in the search box');
      expect(result.success).toBe(true);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]).toMatchObject<Partial<ParsedAction>>({
        action: 'type',
        target: 'search box',
        value: 'hello',
      });
    });

    it('parses "enter john@example.com in the email field"', () => {
      const result = parseInstruction('enter john@example.com in the email field');
      expect(result.success).toBe(true);
      expect(result.actions[0]).toMatchObject<Partial<ParsedAction>>({
        action: 'type',
        value: 'john@example.com',
        target: 'email field',
      });
    });

    it('parses "type admin" without a target', () => {
      const result = parseInstruction('type admin');
      expect(result.success).toBe(true);
      expect(result.actions[0]).toMatchObject<Partial<ParsedAction>>({
        action: 'type',
        value: 'admin',
      });
    });

    it('parses "fill in password in the password field"', () => {
      const result = parseInstruction('fill in password in the password field');
      expect(result.success).toBe(true);
      expect(result.actions[0].action).toBe('type');
    });
  });

  describe('single select actions', () => {
    it('parses "select United States from the country dropdown"', () => {
      const result = parseInstruction('select United States from the country dropdown');
      expect(result.success).toBe(true);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]).toMatchObject<Partial<ParsedAction>>({
        action: 'select',
        value: 'United States',
        target: 'country dropdown',
      });
    });

    it('parses "choose Medium from the size picker"', () => {
      const result = parseInstruction('choose Medium from the size picker');
      expect(result.success).toBe(true);
      expect(result.actions[0]).toMatchObject<Partial<ParsedAction>>({
        action: 'select',
        value: 'Medium',
        target: 'size picker',
      });
    });
  });

  describe('navigate actions', () => {
    it('parses "go to https://example.com"', () => {
      const result = parseInstruction('go to https://example.com');
      expect(result.success).toBe(true);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]).toMatchObject<Partial<ParsedAction>>({
        action: 'navigate',
        value: 'https://example.com',
      });
    });

    it('parses "navigate to https://google.com"', () => {
      const result = parseInstruction('navigate to https://google.com');
      expect(result.success).toBe(true);
      expect(result.actions[0].action).toBe('navigate');
      expect(result.actions[0].value).toBe('https://google.com');
    });

    it('parses "open https://dashboard.example.com"', () => {
      const result = parseInstruction('open https://dashboard.example.com');
      expect(result.success).toBe(true);
      expect(result.actions[0].value).toBe('https://dashboard.example.com');
    });

    it('parses "visit https://example.com/path?q=1"', () => {
      const result = parseInstruction('visit https://example.com/path?q=1');
      expect(result.success).toBe(true);
      expect(result.actions[0].value).toContain('example.com');
    });
  });

  describe('scroll actions', () => {
    it('parses "scroll down to the comments section"', () => {
      const result = parseInstruction('scroll down to the comments section');
      expect(result.success).toBe(true);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]).toMatchObject<Partial<ParsedAction>>({
        action: 'scroll',
        target: 'comments section',
      });
    });

    it('parses "scroll down"', () => {
      const result = parseInstruction('scroll down');
      expect(result.success).toBe(true);
      expect(result.actions[0]).toMatchObject<Partial<ParsedAction>>({
        action: 'scroll',
        value: 'down',
      });
    });

    it('parses "scroll up"', () => {
      const result = parseInstruction('scroll up');
      expect(result.success).toBe(true);
      expect(result.actions[0]).toMatchObject<Partial<ParsedAction>>({
        action: 'scroll',
        value: 'up',
      });
    });

    it('parses "scroll to the footer"', () => {
      const result = parseInstruction('scroll to the footer');
      expect(result.success).toBe(true);
      expect(result.actions[0]).toMatchObject<Partial<ParsedAction>>({
        action: 'scroll',
        target: 'footer',
      });
    });
  });

  describe('wait actions', () => {
    it('parses "wait for the loading spinner to disappear"', () => {
      const result = parseInstruction('wait for the loading spinner to disappear');
      expect(result.success).toBe(true);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]).toMatchObject<Partial<ParsedAction>>({
        action: 'wait',
        target: 'loading spinner',
        condition: 'disappear',
      });
    });

    it('parses "wait for the modal to appear"', () => {
      const result = parseInstruction('wait for the modal to appear');
      expect(result.success).toBe(true);
      expect(result.actions[0]).toMatchObject<Partial<ParsedAction>>({
        action: 'wait',
        target: 'modal',
        condition: 'appear',
      });
    });

    it('parses "wait for the page to load"', () => {
      const result = parseInstruction('wait for the page to load');
      expect(result.success).toBe(true);
      expect(result.actions[0]).toMatchObject<Partial<ParsedAction>>({
        action: 'wait',
        target: 'page',
        condition: 'load',
      });
    });

    it('defaults condition to "appear" when no condition given', () => {
      const result = parseInstruction('wait for the dashboard');
      expect(result.success).toBe(true);
      expect(result.actions[0].condition).toBe('appear');
      expect(result.actions[0].target).toBe('dashboard');
    });
  });

  describe('check/uncheck actions', () => {
    it('parses "check the terms checkbox"', () => {
      const result = parseInstruction('check the terms checkbox');
      expect(result.success).toBe(true);
      expect(result.actions[0].action).toBe('check');
    });

    it('parses "uncheck the newsletter option"', () => {
      const result = parseInstruction('uncheck the newsletter option');
      expect(result.success).toBe(true);
      expect(result.actions[0].action).toBe('uncheck');
    });
  });

  describe('hover actions', () => {
    it('parses "hover over the profile menu"', () => {
      const result = parseInstruction('hover over the profile menu');
      expect(result.success).toBe(true);
      expect(result.actions[0]).toMatchObject<Partial<ParsedAction>>({
        action: 'hover',
        target: 'profile menu',
      });
    });

    it('parses "hover the tooltip icon"', () => {
      const result = parseInstruction('hover the tooltip icon');
      expect(result.success).toBe(true);
      expect(result.actions[0].action).toBe('hover');
    });
  });

  // -------------------------------------------------------------------------
  // Compound / multi-step English instructions
  // -------------------------------------------------------------------------
  describe('compound instructions', () => {
    it('parses "click login, type admin, click submit" into 3 steps', () => {
      const result = parseInstruction('click login, type admin, click submit');
      expect(result.success).toBe(true);
      expect(result.actions).toHaveLength(3);
      expect(result.actions[0].action).toBe('click');
      expect(result.actions[1].action).toBe('type');
      expect(result.actions[2].action).toBe('click');
    });

    it('parses "click next then wait for the page to load" into 2 steps', () => {
      const result = parseInstruction('click next then wait for the page to load');
      expect(result.success).toBe(true);
      expect(result.actions).toHaveLength(2);
      expect(result.actions[0].action).toBe('click');
      expect(result.actions[1].action).toBe('wait');
    });

    it('parses "type email and click submit" into 2 steps', () => {
      const result = parseInstruction('type email and click submit');
      expect(result.success).toBe(true);
      expect(result.actions).toHaveLength(2);
      expect(result.actions[0].action).toBe('type');
      expect(result.actions[1].action).toBe('click');
    });

    it('parses ", then " separator', () => {
      const result = parseInstruction('click the button, then type hello in the field');
      expect(result.success).toBe(true);
      expect(result.actions).toHaveLength(2);
    });

    it('parses ", and then " separator', () => {
      const result = parseInstruction('scroll down, and then click the footer link');
      expect(result.success).toBe(true);
      expect(result.actions).toHaveLength(2);
      expect(result.actions[0].action).toBe('scroll');
      expect(result.actions[1].action).toBe('click');
    });

    it('does NOT split "name and email" (no verb after "and")', () => {
      // "type name and email in the form" — "email" is not a verb start
      const result = parseInstruction('type name and email in the form');
      expect(result.success).toBe(true);
      // Should be a single type action, not split into two
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].action).toBe('type');
    });
  });

  // -------------------------------------------------------------------------
  // Korean i18n
  // -------------------------------------------------------------------------
  describe('Korean instructions', () => {
    it('parses "로그인 버튼을 클릭해"', () => {
      const result = parseInstruction('로그인 버튼을 클릭해');
      expect(result.success).toBe(true);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]).toMatchObject<Partial<ParsedAction>>({
        action: 'click',
      });
      expect(result.actions[0].target).toMatch(/로그인/);
    });

    it('parses "검색창에 안녕하세요를 입력"', () => {
      const result = parseInstruction('검색창에 안녕하세요를 입력');
      expect(result.success).toBe(true);
      expect(result.actions[0]).toMatchObject<Partial<ParsedAction>>({
        action: 'type',
      });
    });

    it('parses "https://example.com로 이동"', () => {
      const result = parseInstruction('https://example.com로 이동');
      expect(result.success).toBe(true);
      expect(result.actions[0].action).toBe('navigate');
    });

    it('parses Korean multi-step "이메일을 입력하고 제출 버튼을 클릭해"', () => {
      const result = parseInstruction('이메일을 입력하고 제출 버튼을 클릭해');
      expect(result.success).toBe(true);
      // Should detect at minimum the type action
      expect(result.actions.length).toBeGreaterThanOrEqual(1);
      const verbs = result.actions.map(a => a.action);
      expect(verbs).toContain('type');
    });

    it('parses "스크롤"', () => {
      const result = parseInstruction('스크롤');
      expect(result.success).toBe(true);
      expect(result.actions[0].action).toBe('scroll');
    });

    it('parses "로딩 스피너를 기다리"', () => {
      const result = parseInstruction('로딩 스피너를 기다리');
      expect(result.success).toBe(true);
      expect(result.actions[0].action).toBe('wait');
    });
  });

  // -------------------------------------------------------------------------
  // URL detection in any phrase
  // -------------------------------------------------------------------------
  describe('URL detection', () => {
    it('detects URL even without navigate verb', () => {
      const result = parseInstruction('https://example.com');
      expect(result.success).toBe(true);
      expect(result.actions[0].action).toBe('navigate');
      expect(result.actions[0].value).toBe('https://example.com');
    });
  });
});
